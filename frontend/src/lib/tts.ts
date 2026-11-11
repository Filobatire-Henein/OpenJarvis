import { create } from 'zustand';
import { synthesizeSpeech, fetchTtsHealth } from './api';
import { toSpeakableText } from './message-text';
import { audioContext, detachAudio, trackNode, unlockAudio } from './orb';
import { SpeechStream } from './voiceStream';

export type TtsState = 'idle' | 'loading' | 'speaking';

/**
 * Voice output is a single shared resource: one utterance at a time, for the
 * whole app. The state lives in one store rather than per component, because a
 * per-component hook would give every message its own audio element -- two
 * replies would then talk over each other, and autoplay would make that the
 * normal case rather than the exception.
 */
interface TtsStore {
  state: TtsState;
  /** id of the message currently loading or speaking, if any. */
  speakingId: string | null;
  error: string | null;
  /** Message whose read-aloud attempt failed, if any. */
  errorId: string | null;
  /** null until the health probe has answered. */
  available: boolean | null;
  /** Last message spoken by autoplay, so a re-render never repeats it. */
  autoSpokenId: string | null;
  speak: (id: string, text: string) => Promise<void>;
  /**
   * Speak a reply while it streams: call with the whole text so far, and once
   * more with final=true. Each message is followed at most once, so a reply
   * the user stopped is never restarted by the next streamed token.
   */
  follow: (id: string, text: string, final: boolean) => void;
  stop: () => void;
  ensureHealth: () => Promise<void>;
  markAutoSpoken: (id: string) => void;
}

// Playback handles are not render state -- keeping them out of the store avoids
// re-rendering every subscriber when a clip is scheduled.
let stream: SpeechStream | null = null;
let streamId: string | null = null;
let healthProbe: Promise<void> | null = null;

/** Only a stream ending in the active conversation may trigger autoplay. */
export function shouldAutoplayFinishedReply(
  previousStreamingConversationId: string | null,
  activeId: string | null,
  streamIsActive: boolean,
  lastMessage: { id: string; role: string } | undefined,
  autoSpokenId: string | null,
): boolean {
  return previousStreamingConversationId !== null
    && previousStreamingConversationId === activeId
    && !streamIsActive
    && lastMessage !== undefined
    && lastMessage.role === 'assistant'
    && lastMessage.id !== autoSpokenId;
}

function teardown(): void {
  stream?.stop();
  stream = null;
  streamId = null;
  detachAudio();
}

// Webviews only allow audio to start inside a user gesture. Unlock the shared
// AudioContext on the first click or key press so replies can be spoken later
// with no click at all.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const unlock = () => unlockAudio();
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
}

export const useTtsStore = create<TtsStore>((set, get) => ({
  state: 'idle',
  speakingId: null,
  error: null,
  errorId: null,
  available: null,
  autoSpokenId: null,

  ensureHealth: () => {
    if (healthProbe) return healthProbe;
    healthProbe = fetchTtsHealth()
      .then((health) => {
        set({ available: health.available });
        if (!health.available) healthProbe = null;
      })
      .catch(() => {
        set({ available: false });
        healthProbe = null;
      });
    return healthProbe;
  },

  markAutoSpoken: (id: string) => set({ autoSpokenId: id }),

  speak: async (id: string, text: string) => {
    if (!toSpeakableText(text)) return;
    unlockAudio();
    open(id, set).update(text, true);
  },

  follow: (id: string, text: string, final: boolean) => {
    if (streamId === id && stream) {
      stream.update(text, final);
      return;
    }
    if (get().autoSpokenId === id) return; // already spoken, or stopped by the user
    set({ autoSpokenId: id });
    open(id, set).update(text, final);
  },

  stop: () => {
    teardown();
    set({ state: 'idle', speakingId: null, error: null, errorId: null });
  },
}));

type SetFn = (partial: Partial<TtsStore>) => void;

function open(id: string, set: SetFn): SpeechStream {
  teardown();
  const mine: SpeechStream = new SpeechStream(
    {
      synth: (text, signal) => synthesizeSpeech(text, { signal }),
      context: audioContext,
      onLevelNode: trackNode, // lets the orb ripple with the voice
    },
    (status) => {
      if (stream !== mine) return;
      if (status === 'speaking') {
        set({ state: 'speaking', speakingId: id });
      } else if (status === 'done') {
        stream = null;
        streamId = null;
        detachAudio();
        set({ state: 'idle', speakingId: null });
      }
    },
    (msg) => {
      if (stream !== mine) return;
      stream = null;
      streamId = null;
      detachAudio();
      set({ state: 'idle', speakingId: null, error: msg, errorId: id });
    },
  );
  stream = mine;
  streamId = id;
  set({ state: 'loading', speakingId: id, error: null, errorId: null });
  return mine;
}

/** Test seam: reset module-level playback handles between cases. */
export function __resetTtsForTests(): void {
  teardown();
  healthProbe = null;
  useTtsStore.setState({
    state: 'idle',
    speakingId: null,
    error: null,
    errorId: null,
    available: null,
    autoSpokenId: null,
  });
}
