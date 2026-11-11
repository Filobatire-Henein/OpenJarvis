import { useEffect, useRef } from 'react';
import { useAppStore } from '../lib/store';
import { useTtsStore } from '../lib/tts';

/**
 * Speak replies *while they stream*: the voice starts as soon as the first
 * sentence is complete, instead of waiting for the whole answer. Only a reply
 * that streams in the active conversation is spoken -- opening the app or
 * switching chats never reads old history aloud.
 *
 * Shared by the chat view and Jarvis mode. Mount it in exactly one visible
 * view at a time.
 */
export function useReplyAutoplay(): void {
  const activeId = useAppStore((s) => s.activeId);
  const messages = useAppStore((s) => s.messages);
  const streamState = useAppStore((s) => s.streamState);
  const voiceOutputEnabled = useAppStore((s) => s.settings.voiceOutputEnabled);
  const voiceAutoplay = useAppStore((s) => s.settings.voiceAutoplay);

  // Probe the backend as soon as voice output is switched on.
  useEffect(() => {
    if (!voiceOutputEnabled) return;
    useTtsStore.getState().ensureHealth();
  }, [voiceOutputEnabled]);

  /** The reply being followed, and the longest text seen for it. */
  const followingRef = useRef<{ conv: string; msg: string; text: string } | null>(null);

  useEffect(() => {
    const tts = useTtsStore.getState();
    const enabled = voiceOutputEnabled && voiceAutoplay && tts.available !== false;
    const streaming = streamState.isStreaming && streamState.conversationId === activeId;
    const last = messages[messages.length - 1];
    const f = followingRef.current;

    if (streaming && enabled && activeId && last?.role === 'assistant') {
      const text = streamState.content || last.content;
      if (f && f.msg !== last.id) tts.follow(f.msg, f.text, true);
      const prev = f && f.msg === last.id ? f.text : '';
      followingRef.current = { conv: activeId, msg: last.id, text: text.length >= prev.length ? text : prev };
      tts.follow(last.id, followingRef.current.text, false);
      return;
    }

    if (!f) return;
    // The stream ended (or the user switched chats): flush what is left.
    followingRef.current = null;
    const finalText =
      last && last.id === f.msg && last.content.length >= f.text.length ? last.content : f.text;
    tts.follow(f.msg, finalText, true);
  }, [
    activeId,
    messages,
    streamState.isStreaming,
    streamState.content,
    streamState.conversationId,
    voiceOutputEnabled,
    voiceAutoplay,
  ]);
}
