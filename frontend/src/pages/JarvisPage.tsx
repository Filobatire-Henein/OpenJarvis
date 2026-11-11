/**
 * Jarvis mode: a full-screen orb with a live caption of what the assistant is
 * saying, and the normal input (mic + text) underneath. It shares the active
 * conversation with the chat view, so you can switch back and forth.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { MessageSquare } from 'lucide-react';
import { JarvisOrb } from '../components/Orb/JarvisOrb';
import { InputArea } from '../components/Chat/InputArea';
import { useOrbMode } from '../hooks/useOrbMode';
import { useReplyAutoplay } from '../hooks/useReplyAutoplay';
import { useAppStore } from '../lib/store';
import { stripThinkTags, toSpeakableText } from '../lib/message-text';

const STATUS: Record<string, string> = {
  idle: 'At your service.',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: '',
};

function useOrbSize(): number {
  const pick = () => Math.round(Math.min(window.innerWidth * 0.78, window.innerHeight * 0.5, 460));
  const [size, setSize] = useState(pick);
  useEffect(() => {
    const onResize = () => setSize(pick());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

export function JarvisPage() {
  const navigate = useNavigate();
  const mode = useOrbMode();
  const size = useOrbSize();
  useReplyAutoplay();

  const activeId = useAppStore((s) => s.activeId);
  const messages = useAppStore((s) => s.messages);
  const streamState = useAppStore((s) => s.streamState);
  const streaming = streamState.isStreaming && streamState.conversationId === activeId;

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const raw = streaming && streamState.content ? streamState.content : lastAssistant?.content ?? '';
  const caption = toSpeakableText(stripThinkTags(raw));
  // Keep the caption short on screen; the full reply is in the chat view.
  const shown = caption.length > 280 ? `${caption.slice(0, 280).trimEnd()}…` : caption;

  return (
    <div
      className="relative flex flex-col h-full overflow-hidden"
      style={{
        background:
          'radial-gradient(ellipse at 50% 38%, var(--color-accent-subtle) 0%, transparent 60%), var(--color-bg)',
      }}
    >
      {/* Left-aligned: the top-right corner belongs to the approval bell. */}
      <div className="flex items-center justify-start px-3 py-1.5 shrink-0">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs cursor-pointer"
          style={{ color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border)' }}
          title="Back to chat"
        >
          <MessageSquare size={14} />
          Chat view
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 min-h-0">
        <JarvisOrb mode={mode} size={size} />
        <p
          className="mt-4 text-xs tracking-[0.25em] uppercase"
          style={{ color: 'var(--color-accent)' }}
          aria-live="polite"
        >
          {mode === 'speaking' ? 'Speaking' : STATUS[mode]}
        </p>
        {shown && (
          <p
            className="mt-3 max-w-xl text-center text-base leading-relaxed"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {shown}
          </p>
        )}
      </div>

      <InputArea />
    </div>
  );
}

export default JarvisPage;
