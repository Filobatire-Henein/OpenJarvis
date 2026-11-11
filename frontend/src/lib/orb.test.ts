import { describe, expect, it } from 'vitest';
import { deriveOrbMode, readLevel, trackElement, useOrbFlags } from './orb';

describe('deriveOrbMode', () => {
  it('is idle when nothing is happening', () => {
    expect(deriveOrbMode({ speaking: false, listening: false, thinking: false })).toBe('idle');
  });

  it('speaking wins over everything', () => {
    expect(deriveOrbMode({ speaking: true, listening: true, thinking: true })).toBe('speaking');
  });

  it('listening wins over thinking', () => {
    expect(deriveOrbMode({ speaking: false, listening: true, thinking: true })).toBe('listening');
  });

  it('thinking while a reply streams', () => {
    expect(deriveOrbMode({ speaking: false, listening: false, thinking: true })).toBe('thinking');
  });
});

describe('audio level', () => {
  it('is zero and stays in range without an analyser', () => {
    const level = readLevel();
    expect(level).toBeGreaterThanOrEqual(0);
    expect(level).toBeLessThanOrEqual(1);
  });

  it('never throws when Web Audio is unavailable (e.g. tests, old webviews)', () => {
    // Tests run in node: no window/AudioContext, so this must be a no-op.
    expect(() => trackElement({} as HTMLMediaElement)).not.toThrow();
  });
});

describe('listening flag', () => {
  it('toggles', () => {
    useOrbFlags.getState().setListening(true);
    expect(useOrbFlags.getState().listening).toBe(true);
    useOrbFlags.getState().setListening(false);
    expect(useOrbFlags.getState().listening).toBe(false);
  });
});
