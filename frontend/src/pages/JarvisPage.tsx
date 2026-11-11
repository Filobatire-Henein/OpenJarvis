/**
 * Jarvis mode: a full-screen orb with a live caption of what the assistant is
 * saying, and the normal input (mic + text) underneath. It shares the active
 * conversation with the chat view, so you can switch back and forth.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { CircleDot, MessageSquare, Share2 } from 'lucide-react';
import { JarvisOrb } from '../components/Orb/JarvisOrb';
import { KnowledgeGraph } from '../components/Mind/KnowledgeGraph';
import { useMindData } from '../hooks/useMindData';
import { buildGraphModel, type GraphModel } from '../lib/graph';
import type { OrbMode } from '../lib/orb';
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

type View = 'graph' | 'orb';
const VIEW_KEY = 'oj-jarvis-view';

function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'orb' ? 'orb' : 'graph';
  } catch {
    return 'graph';
  }
}

/** Live knowledge graph: memories by community, thoughts lighting up as he answers. */
function JarvisGraph({ mode, size }: { mode: OrbMode; size: number }) {
  const { graph, thoughts, flashes } = useMindData();
  const prev = useRef<GraphModel | undefined>(undefined);
  const model = useMemo(() => {
    if (!graph) return null;
    const m = buildGraphModel(graph, thoughts.slice(-16), prev.current);
    prev.current = m;
    return m;
  }, [graph, thoughts]);
  const empty = graph !== null && graph.nodes.length === 0 && thoughts.length === 0;
  return (
    <div
      className="relative rounded-2xl overflow-hidden"
      style={{ width: 'min(92%, 960px)', height: Math.max(260, size * 1.05), border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <KnowledgeGraph model={model} flashes={flashes} compact active={mode === 'thinking' || mode === 'speaking'} />
      {empty && (
        <p className="absolute inset-0 flex items-center justify-center text-xs pointer-events-none" style={{ color: '#8b90a3' }}>
          His memory graph grows here as you talk.
        </p>
      )}
    </div>
  );
}

export function JarvisPage() {
  const [view, setView] = useState<View>(loadView);
  const switchView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode */
    }
  };
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
        <div className="ml-2 flex rounded-md overflow-hidden" style={{ border: '1px solid var(--color-border)' }}>
          {([['graph', Share2, 'Graph'], ['orb', CircleDot, 'Orb']] as const).map(([v, Icon, label]) => (
            <button
              key={v}
              onClick={() => switchView(v)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs cursor-pointer"
              style={{
                color: view === v ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                background: view === v ? 'var(--color-accent-subtle)' : 'transparent',
              }}
              title={v === 'graph' ? 'Show his memory graph' : 'Show the orb'}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 min-h-0">
        {view === 'graph' ? <JarvisGraph mode={mode} size={size} /> : <JarvisOrb mode={mode} size={size} />}
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
