/**
 * Gapless, streaming voice output.
 *
 * A reply is cut into sentences *while it is still being written*. Each chunk
 * is synthesized in turn (the local voice model runs on one GPU, so parallel
 * requests would not be faster) and scheduled on the Web Audio clock right
 * after the previous one, so there are no gaps between clips.
 *
 * The local voice is a little slower than real time. Starting playback the
 * moment the first clip is ready would therefore run dry mid-reply and stall.
 * Instead we measure how fast synthesis really is and start once enough audio
 * is buffered to cover the rest of the reply -- usually a second or two.
 */
import { toSpeakableText } from './message-text';

export type StreamStatus = 'loading' | 'speaking' | 'done';

export interface StreamDeps {
  synth: (text: string, signal: AbortSignal) => Promise<Blob>;
  context: () => AudioContext | null;
  /** Receives the output node so the orb can follow the voice level. */
  onLevelNode?: (node: AudioNode) => void;
  now?: () => number;
}

/** Characters per synthesis request after the first sentence. */
const CHUNK_TARGET = 160;
/** Never wait longer than this much buffered audio before starting. */
const MAX_PREBUFFER_SEC = 8;
/** Breath between clips, after their own silence has been trimmed. */
const GAP_SEC = 0.12;

/**
 * Reply text that is safe to speak so far: closed <think> blocks removed and
 * anything after an unclosed <think> held back until the model closes it.
 */
export function visibleReplyText(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Some models omit the opening tag; everything before a stray close is reasoning.
  t = t.replace(/^[\s\S]*?<\/think>/i, '');
  const open = t.search(/<think>/i);
  if (open !== -1) t = t.slice(0, open);
  return t.replace(/^\s+/, '');
}

/**
 * Split off complete sentences. A sentence ends at . ! ? … followed by
 * whitespace, or at a line break -- never inside an open ``` code fence.
 * Unless `final`, the unfinished tail is left for the next call.
 */
export function splitSentences(text: string, final: boolean): { pieces: string[]; consumed: number } {
  const pieces: string[] = [];
  let start = 0;
  const re = /[.!?…]+["'”’)\]]*\s+|\n+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    const fences = (text.slice(0, end).match(/```/g) ?? []).length;
    if (fences % 2 === 1) continue; // inside a code block: wait for it to close
    const piece = text.slice(start, end);
    if (piece.trim()) pieces.push(piece);
    start = end;
  }
  if (final && start < text.length) {
    const rest = text.slice(start);
    if (rest.trim()) pieces.push(rest);
    start = text.length;
  }
  return { pieces, consumed: start };
}

/** Drop leading/trailing near-silence so consecutive clips join smoothly. */
export function trimSilence(c: AudioContext, buf: AudioBuffer, threshold = 0.008): AudioBuffer {
  const data = buf.getChannelData(0);
  let first = 0;
  while (first < data.length && Math.abs(data[first]) < threshold) first++;
  let last = data.length - 1;
  while (last > first && Math.abs(data[last]) < threshold) last--;
  if (first >= last) return buf;
  const rate = buf.sampleRate;
  const from = Math.max(0, first - Math.round(0.02 * rate));
  const to = Math.min(data.length, last + Math.round(0.06 * rate));
  if (from === 0 && to === data.length) return buf;
  const out = c.createBuffer(buf.numberOfChannels, to - from, rate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    out.copyToChannel(buf.getChannelData(ch).subarray(from, to), ch);
  }
  return out;
}

export class SpeechStream {
  private consumed = 0;
  private carry = '';
  private queue: string[] = [];
  private pendingChars = 0; // queued + in flight
  private emitted = 0;
  private finalized = false;
  private busy = false;
  private ready: AudioBuffer[] = [];
  private started = false;
  private playing = 0;
  private nextTime = 0;
  private sources: AudioBufferSourceNode[] = [];
  private out: GainNode | null = null;
  private readonly ac = new AbortController();
  private stopped = false;
  private status: StreamStatus = 'loading';
  private synthSec = 0;
  private synthAudioSec = 0;
  private synthChars = 0;

  constructor(
    private readonly deps: StreamDeps,
    private readonly onStatus: (s: StreamStatus) => void,
    private readonly onError: (msg: string) => void,
  ) {}

  /** Feed the whole reply as it stands now; `final` once it is complete. */
  update(rawText: string, final: boolean): void {
    if (this.stopped || this.finalized) return;
    const visible = visibleReplyText(rawText);
    const { pieces, consumed } = splitSentences(visible.slice(this.consumed), final);
    this.consumed += consumed;
    for (const piece of pieces) {
      this.carry += piece;
      // The first sentence goes out alone so the voice starts quickly.
      const target = this.emitted === 0 ? 1 : CHUNK_TARGET;
      if (this.carry.trim().length >= target) this.emit();
    }
    if (final) {
      if (this.carry.trim()) this.emit();
      this.carry = '';
      this.finalized = true;
    }
    void this.pump();
    this.schedule();
    this.maybeFinish();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ac.abort();
    for (const src of this.sources) {
      src.onended = null;
      try { src.stop(); } catch { /* not started */ }
    }
    this.sources = [];
    try { this.out?.disconnect(); } catch { /* already gone */ }
    this.out = null;
  }

  private now(): number {
    return (this.deps.now ?? (() => performance.now()))() / 1000;
  }

  private emit(): void {
    const speakable = toSpeakableText(this.carry);
    this.carry = '';
    if (!speakable) return;
    this.queue.push(speakable);
    this.pendingChars += speakable.length;
    this.emitted += 1;
  }

  private async pump(): Promise<void> {
    if (this.busy || this.stopped) return;
    const text = this.queue.shift();
    if (text === undefined) return;
    this.busy = true;
    const t0 = this.now();
    try {
      const blob = await this.deps.synth(text, this.ac.signal);
      if (this.stopped) return;
      const c = this.deps.context();
      if (!c) throw new Error('Audio output is not available');
      const decoded = await c.decodeAudioData(await blob.arrayBuffer());
      if (this.stopped) return;
      const buf = trimSilence(c, decoded);
      this.synthSec += this.now() - t0;
      this.synthAudioSec += buf.duration;
      this.synthChars += text.length;
      this.pendingChars -= text.length;
      this.ready.push(buf);
    } catch (err) {
      if (this.stopped) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.fail(err instanceof Error ? err.message : 'Speech synthesis failed');
      return;
    } finally {
      this.busy = false;
    }
    this.schedule();
    void this.pump();
    this.maybeFinish();
  }

  /** Enough audio is buffered that playback will not run dry. */
  private shouldStart(): boolean {
    const buffered = this.ready.reduce((sum, b) => sum + b.duration, 0);
    if (buffered <= 0) return false;
    const nothingLeft = this.finalized && !this.busy && this.queue.length === 0;
    if (nothingLeft || buffered >= MAX_PREBUFFER_SEC) return true;
    if (this.synthAudioSec <= 0 || this.synthChars <= 0) return false;
    const rtf = this.synthSec / this.synthAudioSec; // seconds of work per second of audio
    if (rtf <= 0.9) return true;
    const remaining = (this.pendingChars + this.carry.length) * (this.synthAudioSec / this.synthChars);
    // Playing everything takes buffered + remaining; producing the rest takes rtf * remaining.
    return buffered >= remaining * (rtf - 1) + 0.25;
  }

  private schedule(): void {
    if (this.stopped) return;
    const c = this.deps.context();
    if (!c || this.ready.length === 0) return;
    if (!this.started) {
      if (!this.shouldStart()) return;
      this.started = true;
      if (c.state === 'suspended') void c.resume().catch(() => {});
      const out = c.createGain();
      out.connect(c.destination);
      this.out = out;
      this.deps.onLevelNode?.(out);
      this.nextTime = c.currentTime + 0.05;
      this.setStatus('speaking');
    }
    while (this.ready.length) {
      const buf = this.ready.shift()!;
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(this.out!);
      const at = Math.max(this.nextTime, c.currentTime + 0.03);
      src.start(at);
      this.nextTime = at + buf.duration + GAP_SEC;
      this.playing += 1;
      this.sources.push(src);
      src.onended = () => {
        this.playing -= 1;
        this.sources = this.sources.filter((s) => s !== src);
        this.maybeFinish();
      };
    }
  }

  private maybeFinish(): void {
    if (this.stopped || this.status === 'done') return;
    const idle = this.finalized && !this.busy && this.queue.length === 0 && this.ready.length === 0;
    if (idle && this.playing === 0) {
      this.setStatus('done');
      this.stop();
    }
  }

  private setStatus(s: StreamStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }

  private fail(msg: string): void {
    this.stop();
    this.onError(msg);
  }
}
