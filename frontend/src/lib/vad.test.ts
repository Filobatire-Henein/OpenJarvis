import { describe, expect, it } from 'vitest';
import { createSilenceDetector } from './vad';

/** Feed a level for `ms` milliseconds in 50 ms steps; return the last verdict. */
function feed(d: ReturnType<typeof createSilenceDetector>, clock: { t: number }, rms: number, ms: number) {
  let v = 'continue';
  for (let end = clock.t + ms; clock.t < end; clock.t += 50) {
    v = d.push(rms, clock.t);
    if (v !== 'continue') return v;
  }
  return v;
}

describe('end-of-speech detector', () => {
  it('ends the turn after you stop talking', () => {
    const d = createSilenceDetector();
    const c = { t: 0 };
    feed(d, c, 0.003, 400); // room noise
    expect(feed(d, c, 0.08, 1500)).toBe('continue'); // talking
    expect(feed(d, c, 0.003, 1000)).toBe('continue'); // short breath: keep listening
    expect(feed(d, c, 0.08, 500)).toBe('continue');
    expect(feed(d, c, 0.003, 2000)).toBe('ended');
  });

  it('gives up if nothing is said', () => {
    const d = createSilenceDetector({ noSpeechMs: 3000 });
    const c = { t: 0 };
    expect(feed(d, c, 0.003, 5000)).toBe('no-speech');
  });

  it('ignores a single click or bump', () => {
    const d = createSilenceDetector({ noSpeechMs: 3000 });
    const c = { t: 0 };
    feed(d, c, 0.003, 400);
    feed(d, c, 0.2, 50); // one loud frame
    expect(feed(d, c, 0.003, 5000)).toBe('no-speech');
  });

  it('adapts to a noisy room', () => {
    const d = createSilenceDetector({ noSpeechMs: 3000 });
    const c = { t: 0 };
    // Steady fan noise well above the minimum threshold is not speech.
    expect(feed(d, c, 0.03, 5000)).toBe('no-speech');
  });
});
