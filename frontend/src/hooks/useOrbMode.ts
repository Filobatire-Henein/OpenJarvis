import { useAppStore } from '../lib/store';
import { useTtsStore } from '../lib/tts';
import { deriveOrbMode, useOrbFlags, type OrbMode } from '../lib/orb';

/** The orb's current mode, derived from voice output, mic and chat streaming. */
export function useOrbMode(): OrbMode {
  const ttsState = useTtsStore((s) => s.state);
  const listening = useOrbFlags((s) => s.listening);
  const streaming = useAppStore((s) => s.streamState.isStreaming);
  return deriveOrbMode({
    speaking: ttsState === 'speaking',
    listening,
    // 'loading' = synthesizing the reply's voice: still "thinking" visually.
    thinking: streaming || ttsState === 'loading',
  });
}
