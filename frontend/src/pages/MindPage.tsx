/**
 * Mind: Jarvis's memories as a Graphify-style knowledge graph. Memories are
 * dots coloured by community (clusters of related memories, named after their
 * most connected member); live thoughts join the graph as white dots wired to
 * the memories they recalled.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Brain, RefreshCw, Search, X } from 'lucide-react';
import { KnowledgeGraph } from '../components/Mind/KnowledgeGraph';
import { useMindData } from '../hooks/useMindData';
import { buildGraphModel, GRAPH_BG, type GraphModel } from '../lib/graph';

const KIND_LABEL: Record<string, string> = {
  fact: 'Remembered fact',
  doc: 'Stored memory',
  entity: 'Knowledge-graph entity',
  note: 'Note (MEMORY.md / USER.md)',
  'thought:thought': 'Thought',
  'thought:tool': 'Tool call',
  'thought:memory_hit': 'Memory recall',
  'thought:answer': 'Answer',
};

const PANEL_BG = '#141722';
const PANEL_BORDER = 'rgba(255, 255, 255, 0.07)';
const TEXT = '#e6e8f0';
const MUTED = '#8b90a3';

function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

function timeOf(ts: number): string {
  try {
    return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold tracking-[0.14em] uppercase mb-2" style={{ color: MUTED }}>
      {children}
    </h3>
  );
}

export function MindPage() {
  const { graph, loading, error, thoughts, live, flashes, reload } = useMindData();
  const reducedMotion = usePrefersReducedMotion();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const prevModel = useRef<GraphModel | undefined>(undefined);
  const model = useMemo(() => {
    if (!graph) return null;
    const m = buildGraphModel(graph, thoughts, prevModel.current);
    prevModel.current = m;
    return m;
  }, [graph, thoughts]);

  const memoryCount = graph?.nodes.length ?? 0;
  const linkCount = graph?.edges.length ?? 0;
  const selected = model && selectedId ? model.nodes[model.index.get(selectedId) ?? -1] : undefined;
  const allShown = hidden.size === 0;

  const toggle = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const connections = useMemo(() => {
    if (!model || !selected) return [];
    const i = model.index.get(selected.id)!;
    return model.neighbors[i]
      .map((j) => model.nodes[j])
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 14);
  }, [model, selected]);

  const isEmpty = !loading && !error && memoryCount === 0 && thoughts.length === 0;

  return (
    <div className="flex flex-col md:flex-row h-full min-h-0" style={{ background: GRAPH_BG }}>
      <div className="relative flex-1 min-h-[300px] min-w-0">
        <KnowledgeGraph
          model={model}
          hidden={hidden}
          query={query}
          selectedId={selectedId}
          onSelect={setSelectedId}
          flashes={flashes}
          reducedMotion={reducedMotion}
        />
        {isEmpty && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6 pointer-events-none">
            <Brain size={30} style={{ color: '#4e79a7', opacity: 0.8 }} />
            <p className="mt-3 text-sm" style={{ color: MUTED }}>
              No memories yet — chat with Jarvis and they'll appear here.
            </p>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
            <p className="text-sm" style={{ color: '#e15759' }}>Couldn't load memories: {error}</p>
            <button
              onClick={() => void reload()}
              className="mt-3 px-3 py-1.5 rounded-md text-xs cursor-pointer"
              style={{ color: TEXT, border: `1px solid ${PANEL_BORDER}` }}
            >
              Try again
            </button>
          </div>
        )}
      </div>

      <aside
        className="w-full md:w-[300px] shrink-0 overflow-y-auto max-h-[45%] md:max-h-none px-4 py-4 flex flex-col gap-5"
        style={{ background: PANEL_BG, borderLeft: `1px solid ${PANEL_BORDER}`, color: TEXT }}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">Mind</h2>
            <p className="text-xs mt-0.5" style={{ color: MUTED }}>
              {memoryCount} memories · {linkCount} links
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-[11px]" style={{ color: MUTED }} title="Live thought stream">
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: live === 'live' ? '#59a14f' : live === 'connecting' ? '#edc948' : '#e15759' }}
              />
              {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting' : 'Reconnecting'}
            </span>
            <button
              onClick={() => void reload()}
              className="p-1.5 rounded-md cursor-pointer"
              style={{ color: MUTED }}
              title="Refresh"
            >
              <RefreshCw size={13} />
            </button>
          </div>
        </div>

        <label className="flex items-center gap-2 px-2.5 py-1.5 rounded-md" style={{ background: GRAPH_BG, border: `1px solid ${PANEL_BORDER}` }}>
          <Search size={13} style={{ color: MUTED }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memories"
            className="flex-1 bg-transparent outline-none text-xs"
            style={{ color: TEXT }}
          />
          {query && (
            <button onClick={() => setQuery('')} className="cursor-pointer" style={{ color: MUTED }} title="Clear">
              <X size={12} />
            </button>
          )}
        </label>

        {selected && (
          <section className="rounded-lg p-3" style={{ background: GRAPH_BG, border: `1px solid ${PANEL_BORDER}` }}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: selected.color }} />
                <span className="text-[11px]" style={{ color: MUTED }}>{KIND_LABEL[selected.kind] ?? selected.kind}</span>
              </div>
              <button onClick={() => setSelectedId(null)} className="cursor-pointer" style={{ color: MUTED }} title="Close">
                <X size={13} />
              </button>
            </div>
            <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap break-words">{selected.text || selected.label}</p>
            {selected.thought && (
              <p className="mt-1 text-[11px]" style={{ color: MUTED }}>{timeOf(selected.thought.ts)}</p>
            )}
            {connections.length > 0 && (
              <div className="mt-3">
                <p className="text-[11px] mb-1.5" style={{ color: MUTED }}>Connected to {model!.neighbors[model!.index.get(selected.id)!].length}</p>
                <ul className="flex flex-col gap-1">
                  {connections.map((n) => (
                    <li key={n.id}>
                      <button
                        onClick={() => setSelectedId(n.id)}
                        className="flex items-center gap-2 text-xs text-left w-full cursor-pointer hover:underline"
                        style={{ color: TEXT }}
                      >
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: n.color }} />
                        <span className="truncate">{n.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        <section>
          <SectionTitle>Communities</SectionTitle>
          {model && model.communities.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              <li>
                <label className="flex items-center gap-2.5 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allShown}
                    onChange={() => setHidden(allShown ? new Set(model.communities.map((c) => c.id)) : new Set())}
                    className="accent-[#4e79a7]"
                  />
                  Select All
                </label>
              </li>
              {model.communities.map((c) => (
                <li key={c.id}>
                  <label className="flex items-center gap-2.5 text-sm cursor-pointer">
                    <input type="checkbox" checked={!hidden.has(c.id)} onChange={() => toggle(c.id)} className="accent-[#4e79a7]" />
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: c.color }} />
                    <span className="flex-1 truncate" title={c.name}>{c.name}</span>
                    <span className="text-xs tabular-nums" style={{ color: MUTED }}>{c.size}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs" style={{ color: MUTED }}>{loading ? 'Loading…' : 'None yet.'}</p>
          )}
        </section>

        <section>
          <SectionTitle>Live thoughts</SectionTitle>
          {thoughts.length === 0 ? (
            <p className="text-xs" style={{ color: MUTED }}>Ask Jarvis something to watch him think.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {[...thoughts].reverse().slice(0, 14).map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => setSelectedId(`t:${t.id}`)}
                    className="w-full text-left text-xs leading-snug cursor-pointer hover:underline"
                    style={{ color: TEXT }}
                  >
                    <span style={{ color: MUTED }}>{timeOf(t.ts)} · </span>
                    {t.text.length > 90 ? `${t.text.slice(0, 89)}…` : t.text}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}

export default MindPage;
