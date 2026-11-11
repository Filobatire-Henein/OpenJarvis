import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  synthesizeSpeech: vi.fn(),
  fetchTtsHealth: vi.fn(),
}));

// A fake Web Audio graph: node has no AudioContext, and timing must be
// controllable to test gapless scheduling.
class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  connect() {}
  disconnect() {}
  start(at: number) { this.startedAt = at; }
  stop() { this.stopped = true; }
}
class FakeContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  sources: FakeSource[] = [];
  createGain() { return { connect() {}, disconnect() {} }; }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
  async decodeAudioData(ab: ArrayBuffer) {
    // 1 byte of "audio" = 1 second, so tests can choose clip lengths.
    const duration = ab.byteLength;
    const data = new Float32Array(10).fill(0.5);
    return { duration, sampleRate: 10, numberOfChannels: 1, getChannelData: () => data, length: 10 };
  }
  createBuffer() { throw new Error('not used'); }
  resume() { return Promise.resolve(); }
}
let fakeCtx = new FakeContext();

vi.mock('./orb', () => ({
  audioContext: () => fakeCtx,
  unlockAudio: () => {},
  trackNode: () => {},
  detachAudio: () => {},
}));

import { synthesizeSpeech, fetchTtsHealth } from './api';
import { useTtsStore, __resetTtsForTests, shouldAutoplayFinishedReply } from './tts';

const synth = vi.mocked(synthesizeSpeech);
const health = vi.mocked(fetchTtsHealth);

/** A blob whose decoded "audio" lasts `sec` seconds in the fake context. */
const clip = (sec = 1) => ({ arrayBuffer: async () => new ArrayBuffer(sec) }) as unknown as Blob;

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fakeCtx = new FakeContext();
  synth.mockReset();
  health.mockReset();
  __resetTtsForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('shared voice output', () => {
  it('plays one utterance and reports which message owns it', async () => {
    synth.mockResolvedValue(clip());

    await useTtsStore.getState().speak('m1', 'Hello there.');
    await flush();

    expect(fakeCtx.sources).toHaveLength(1);
    expect(fakeCtx.sources[0].startedAt).not.toBeNull();
    expect(useTtsStore.getState().state).toBe('speaking');
    expect(useTtsStore.getState().speakingId).toBe('m1');
  });

  it('goes idle with no error once the last clip ends', async () => {
    synth.mockResolvedValue(clip());
    await useTtsStore.getState().speak('m1', 'Hello.');
    await flush();

    fakeCtx.sources[0].onended?.();

    expect(useTtsStore.getState().state).toBe('idle');
    expect(useTtsStore.getState().error).toBeNull();
  });

  it('schedules sentences back to back instead of pausing between them', async () => {
    synth.mockResolvedValue(clip(2));
    await useTtsStore.getState().speak('m1', 'First sentence here. Second sentence follows right after it, and it is a little longer so it is its own chunk.');
    await flush();
    await flush();

    const [a, b] = fakeCtx.sources;
    expect(a.startedAt).not.toBeNull();
    // Second clip is queued on the audio clock to begin where the first ends.
    expect(b.startedAt! - a.startedAt!).toBeCloseTo(2 + 0.12, 5);
  });

  it('starting a second message stops the first instead of overlapping it', async () => {
    synth.mockResolvedValue(clip());

    await useTtsStore.getState().speak('m1', 'Erste.');
    await flush();
    const first = fakeCtx.sources[0];

    await useTtsStore.getState().speak('m2', 'Zweite.');
    await flush();

    expect(first.stopped).toBe(true);
    expect(useTtsStore.getState().speakingId).toBe('m2');
  });

  it('aborts a synthesis that is superseded before it resolves', async () => {
    const pending = deferred<Blob>();
    synth.mockReturnValueOnce(pending.promise);
    synth.mockResolvedValueOnce(clip());

    await useTtsStore.getState().speak('m1', 'Erste.');
    const signal = synth.mock.calls[0][1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    await useTtsStore.getState().speak('m2', 'Zweite.');
    await flush();
    expect(signal.aborted).toBe(true);

    pending.resolve(clip());
    await flush();

    expect(fakeCtx.sources).toHaveLength(1);
    expect(useTtsStore.getState().speakingId).toBe('m2');
  });

  it('stop() halts playback', async () => {
    synth.mockResolvedValue(clip());
    await useTtsStore.getState().speak('m1', 'Hallo.');
    await flush();

    useTtsStore.getState().stop();

    expect(fakeCtx.sources[0].stopped).toBe(true);
    expect(useTtsStore.getState().state).toBe('idle');
    expect(useTtsStore.getState().speakingId).toBeNull();
  });

  it('follows a streaming reply and starts on the first full sentence', async () => {
    synth.mockResolvedValue(clip());
    const tts = useTtsStore.getState();

    tts.follow('m1', 'Hello', false);
    expect(synth).not.toHaveBeenCalled(); // sentence not finished yet
    tts.follow('m1', 'Hello there. How', false);
    expect(synth).toHaveBeenCalledTimes(1);
    expect(synth.mock.calls[0][0]).toBe('Hello there.');

    tts.follow('m1', 'Hello there. How are you?', true);
    await flush();
    await flush();
    expect(synth.mock.calls.map((c) => c[0])).toEqual(['Hello there.', 'How are you?']);
  });

  it('never restarts a reply the user stopped', async () => {
    synth.mockResolvedValue(clip());
    const tts = useTtsStore.getState();
    tts.follow('m1', 'One sentence. ', false);
    tts.stop();
    tts.follow('m1', 'One sentence. Two sentences. ', false);
    expect(useTtsStore.getState().state).toBe('idle');
    expect(synth).toHaveBeenCalledTimes(1);
  });

  it('does not speak hidden reasoning', () => {
    synth.mockResolvedValue(clip());
    useTtsStore.getState().follow('m1', '<think>Let me think. Really.', false);
    expect(synth).not.toHaveBeenCalled();
    useTtsStore.getState().follow('m1', '<think>Let me think. Really.</think>Answer is here. ', false);
    expect(synth.mock.calls.map((c) => c[0])).toEqual(['Answer is here.']);
  });

  it('surfaces a synthesis failure', async () => {
    synth.mockRejectedValue(new Error('Voice server down'));

    await useTtsStore.getState().speak('m1', 'Hallo.');
    await flush();

    const state = useTtsStore.getState();
    expect(state.state).toBe('idle');
    expect(state.error).toBe('Voice server down');
    expect(state.errorId).toBe('m1');
  });

  it('ignores empty text', async () => {
    await useTtsStore.getState().speak('m1', '   ');
    expect(synth).not.toHaveBeenCalled();
  });

  it('probes the backend once no matter how many callers ask', () => {
    health.mockResolvedValue({ available: true });

    useTtsStore.getState().ensureHealth();
    useTtsStore.getState().ensureHealth();
    useTtsStore.getState().ensureHealth();

    expect(health).toHaveBeenCalledTimes(1);
  });

  it('shares a pending health probe so autoplay can wait for model loading', async () => {
    const pending = deferred<{ available: boolean }>();
    health.mockReturnValue(pending.promise);

    const first = useTtsStore.getState().ensureHealth();
    const second = useTtsStore.getState().ensureHealth();
    expect(second).toBe(first);
    expect(health).toHaveBeenCalledTimes(1);

    pending.resolve({ available: true });
    await first;
    expect(useTtsStore.getState().available).toBe(true);
  });

  it('retries health after an unavailable response', async () => {
    health.mockResolvedValueOnce({ available: false });
    health.mockResolvedValueOnce({ available: true });

    await useTtsStore.getState().ensureHealth();
    expect(useTtsStore.getState().available).toBe(false);
    await useTtsStore.getState().ensureHealth();

    expect(health).toHaveBeenCalledTimes(2);
    expect(useTtsStore.getState().available).toBe(true);
  });

  it('retries health after a network error', async () => {
    health.mockRejectedValueOnce(new Error('offline'));
    health.mockResolvedValueOnce({ available: true });

    await useTtsStore.getState().ensureHealth();
    expect(useTtsStore.getState().available).toBe(false);
    await useTtsStore.getState().ensureHealth();

    expect(health).toHaveBeenCalledTimes(2);
    expect(useTtsStore.getState().available).toBe(true);
  });
});

describe('autoplay gating', () => {
  it('stays silent when a finished conversation is merely restored', () => {
    expect(
      shouldAutoplayFinishedReply(null, 'chat-1', false, { role: 'assistant', id: 'old' }, null),
    ).toBe(false);
  });

  it('speaks when a stream finishes', () => {
    expect(
      shouldAutoplayFinishedReply('chat-1', 'chat-1', false, { role: 'assistant', id: 'fresh' }, null),
    ).toBe(true);
  });

  it('stays silent while the reply is still streaming', () => {
    expect(
      shouldAutoplayFinishedReply('chat-1', 'chat-1', true, { role: 'assistant', id: 'fresh' }, null),
    ).toBe(false);
  });

  it('never repeats a message it already spoke', () => {
    expect(
      shouldAutoplayFinishedReply('chat-1', 'chat-1', false, { role: 'assistant', id: 'fresh' }, 'fresh'),
    ).toBe(false);
  });

  it('ignores a trailing user message', () => {
    expect(
      shouldAutoplayFinishedReply('chat-1', 'chat-1', false, { role: 'user', id: 'u1' }, null),
    ).toBe(false);
  });

  it('does not speak an old reply when the user switches conversations mid-stream', () => {
    expect(
      shouldAutoplayFinishedReply('chat-1', 'chat-2', true, { role: 'assistant', id: 'old' }, null),
    ).toBe(false);
  });
});
