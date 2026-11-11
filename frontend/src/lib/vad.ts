/**
 * Tiny end-of-speech detector for hands-free voice. It is fed the mic's RMS
 * level every ~50 ms and decides when you have finished talking.
 *
 * The first moments set a noise floor, so a fan or room hum does not count as
 * speech. You have to speak for a short while before silence can end the turn,
 * and a pause has to last `silenceMs` -- long enough for a breath or a
 * "hmm" mid-sentence without cutting you off.
 */
export type VadVerdict = 'continue' | 'ended' | 'no-speech';

export interface SilenceDetector {
  push: (rms: number, elapsedMs: number) => VadVerdict;
}

export interface VadOptions {
  silenceMs?: number;
  noSpeechMs?: number;
  maxMs?: number;
  calibrateMs?: number;
  minSpeechMs?: number;
}

export function createSilenceDetector(opts: VadOptions = {}): SilenceDetector {
  const silenceMs = opts.silenceMs ?? 1300;
  const noSpeechMs = opts.noSpeechMs ?? 8000;
  const maxMs = opts.maxMs ?? 60000;
  const calibrateMs = opts.calibrateMs ?? 300;
  const minSpeechMs = opts.minSpeechMs ?? 200;

  let floor = 0;
  let samples = 0;
  let speechMs = 0;
  let started = false;
  let lastLoud = 0;
  let lastT = 0;

  return {
    push(rms, t) {
      const dt = Math.max(0, t - lastT);
      lastT = t;
      if (t < calibrateMs) {
        samples += 1;
        floor += (rms - floor) / samples;
        return 'continue';
      }
      const threshold = Math.max(0.012, floor * 2.5);
      if (rms > threshold) {
        speechMs += dt;
        lastLoud = t;
        if (speechMs >= minSpeechMs) started = true;
      } else {
        // Follow slow changes in background noise, but never learn speech.
        floor = floor * 0.98 + rms * 0.02;
        if (!started) speechMs = Math.max(0, speechMs - dt / 2);
      }
      if (started && t - lastLoud >= silenceMs) return 'ended';
      if (!started && t >= noSpeechMs) return 'no-speech';
      if (t >= maxMs) return started ? 'ended' : 'no-speech';
      return 'continue';
    },
  };
}
