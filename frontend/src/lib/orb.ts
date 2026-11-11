/**
 * Shared state for the Jarvis orb: which mode it is in and how loud the
 * current audio is (mic while listening, TTS while speaking).
 *
 * The level is kept outside React state on purpose: it changes every animation
 * frame, and the orb reads it from requestAnimationFrame, so pushing it
 * through zustand would re-render subscribers 60 times a second.
 */
import { create } from 'zustand';

export type OrbMode = 'idle' | 'listening' | 'thinking' | 'speaking';

interface OrbFlags {
  listening: boolean;
  setListening: (on: boolean) => void;
}

export const useOrbFlags = create<OrbFlags>((set) => ({
  listening: false,
  setListening: (on) => set({ listening: on }),
}));

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let detach: (() => void) | null = null;
let buffer: Uint8Array<ArrayBuffer> | null = null;
let smoothed = 0;

function ctx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => {});
  return audioCtx;
}

function makeAnalyser(c: AudioContext): AnalyserNode {
  const a = c.createAnalyser();
  a.fftSize = 512;
  a.smoothingTimeConstant = 0.6;
  buffer = new Uint8Array(new ArrayBuffer(a.fftSize));
  return a;
}

/** Track the loudness of a mic stream (not routed to the speakers). */
export function trackStream(stream: MediaStream): void {
  const c = ctx();
  if (!c) return;
  detachAudio();
  try {
    const src = c.createMediaStreamSource(stream);
    analyser = makeAnalyser(c);
    src.connect(analyser);
    detach = () => src.disconnect();
  } catch {
    analyser = null;
  }
}

const elementSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

/**
 * Track the loudness of a playing <audio> element. A media element can only
 * be wired into one source node ever, and once wired its sound only reaches
 * the speakers through the graph, so we always connect it to the destination.
 */
export function trackElement(el: HTMLMediaElement): void {
  const c = ctx();
  // A suspended context (no user gesture yet) would swallow the element's
  // sound once wired in, so only tap the level when audio is already flowing;
  // otherwise the orb just animates without a level.
  if (!c || c.state !== 'running') return;
  detachAudio();
  try {
    let src = elementSources.get(el);
    if (!src) {
      src = c.createMediaElementSource(el);
      elementSources.set(el, src);
    }
    analyser = makeAnalyser(c);
    src.connect(analyser);
    src.connect(c.destination);
    const node = src;
    detach = () => {
      try { node.disconnect(analyser!); } catch { /* already gone */ }
    };
  } catch {
    analyser = null;
  }
}

export function detachAudio(): void {
  detach?.();
  detach = null;
  analyser = null;
}

/** Current loudness, 0..1, smoothed. Cheap enough to call every frame. */
export function readLevel(): number {
  let raw = 0;
  if (analyser && buffer) {
    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      const v = (buffer[i] - 128) / 128;
      sum += v * v;
    }
    raw = Math.min(1, Math.sqrt(sum / buffer.length) * 4);
  }
  smoothed += (raw - smoothed) * (raw > smoothed ? 0.5 : 0.12);
  return smoothed;
}

/** Combine the app's signals into one orb mode (speaking wins, then listening). */
export function deriveOrbMode(opts: {
  speaking: boolean;
  listening: boolean;
  thinking: boolean;
}): OrbMode {
  if (opts.speaking) return 'speaking';
  if (opts.listening) return 'listening';
  if (opts.thinking) return 'thinking';
  return 'idle';
}
