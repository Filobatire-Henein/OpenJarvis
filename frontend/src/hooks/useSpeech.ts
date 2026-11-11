import { useState, useCallback, useRef, useEffect } from 'react';
import { transcribeAudio, fetchSpeechHealth } from '../lib/api';
import { audioContext, detachAudio, trackStream, useOrbFlags } from '../lib/orb';
import { createSilenceDetector, type SilenceDetector } from '../lib/vad';

export type SpeechState = 'idle' | 'recording' | 'transcribing';

export interface RecordOptions {
  /** Called once when you stop talking (hands-free mode). */
  onSilence?: () => void;
  /** Called if nothing was said for a while after the mic opened. */
  onNoSpeech?: () => void;
}

export function useSpeech() {
  const [state, setState] = useState<SpeechState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const vadRef = useRef<{ stop: () => void } | null>(null);

  // Check if speech backend is available on mount
  useEffect(() => {
    fetchSpeechHealth()
      .then((health) => setAvailable(health.available))
      .catch(() => setAvailable(false));
  }, []);

  const startRecording = useCallback(async (opts: RecordOptions = {}): Promise<void> => {
    setError(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone not supported in this browser');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      trackStream(stream); // orb swells with your voice
      useOrbFlags.getState().setListening(true);
      setState('recording');

      if (opts.onSilence || opts.onNoSpeech) {
        const c = audioContext();
        if (c) vadRef.current = watchForSilence(c, stream, opts);
      }
    } catch (err) {
      setError('Microphone access denied');
      setState('idle');
    }
  }, []);

  const stopRecording = useCallback(async (): Promise<string> => {
    return new Promise((resolve, reject) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state !== 'recording') {
        reject(new Error('Not recording'));
        return;
      }

      recorder.onstop = async () => {
        vadRef.current?.stop();
        vadRef.current = null;
        detachAudio();
        useOrbFlags.getState().setListening(false);
        setState('transcribing');

        // Stop all audio tracks
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        chunksRef.current = [];

        try {
          const result = await transcribeAudio(blob);
          setState('idle');
          resolve(result.text);
        } catch (err) {
          setState('idle');
          const msg = err instanceof Error ? err.message : 'Transcription failed';
          setError(msg);
          reject(err);
        }
      };

      recorder.stop();
    });
  }, []);

  /** Stop and throw the recording away (no transcription). */
  const cancelRecording = useCallback(() => {
    vadRef.current?.stop();
    vadRef.current = null;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === 'recording') {
      recorder.onstop = null;
      recorder.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    chunksRef.current = [];
    detachAudio();
    useOrbFlags.getState().setListening(false);
    setState('idle');
  }, []);

  return {
    cancelRecording,
    state,
    error,
    available,
    startRecording,
    stopRecording,
    isRecording: state === 'recording',
    isTranscribing: state === 'transcribing',
  };
}

/** Poll the mic level and report end-of-speech / no-speech. */
function watchForSilence(c: AudioContext, stream: MediaStream, opts: RecordOptions): { stop: () => void } {
  const src = c.createMediaStreamSource(stream);
  const analyser = c.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const detector: SilenceDetector = createSilenceDetector();
  const t0 = performance.now();
  let fired = false;
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const verdict = detector.push(Math.sqrt(sum / buf.length), performance.now() - t0);
    if (fired || verdict === 'continue') return;
    fired = true;
    stop();
    if (verdict === 'ended') opts.onSilence?.();
    else opts.onNoSpeech?.();
  }, 50);
  function stop() {
    window.clearInterval(timer);
    try { src.disconnect(); } catch { /* gone */ }
  }
  return { stop };
}
