import { useCallback, useEffect, useRef, useState } from 'react';
import { Brain, RefreshCw } from 'lucide-react';
import {
  BUBBLE_LIFETIME_MS,
  bubbleScale,
  createSimulation,
  decayPulses,
  fetchMindGraph,
  hitTest,
  NODE_COLOR_VAR,
  NODE_KIND_LABEL,
  pulseLinked,
  settle,
  spawnBubble,
  stepBubbles,
  streamMind,
  THOUGHT_COLOR_VAR,
  tick,
  withAlpha,
  type Bubble,
  type MindGraph,
  type Simulation,
  type Thought,
} from '../lib/mind';

const MAX_LIST = 40;
const THOUGHT_LABEL: Record<Thought['type'], string> = {
  thought: 'Thinking',
  tool: 'Tool',
  memory_hit: 'Memory',
  answer: 'Answer',
};

interface Palette {
  dark: boolean;
  bg: string;
  text: string;
  textMuted: string;
  accent: string;
  vars: Record<string, string>;
}

function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const vars: Record<string, string> = {};
  for (const name of [
    ...Object.values(NODE_COLOR_VAR),
    ...Object.values(THOUGHT_COLOR_VAR),
  ]) {
    vars[name] = get(name, '#22d3ee');
  }
  return {
    dark: document.documentElement.classList.contains('dark'),
    bg: get('--color-bg', '#0a0a0b'),
    text: get('--color-text', '#ededef'),
    textMuted: get('--color-text-tertiary', '#5c5c63'),
    accent: get('--color-accent', '#22d3ee'),
    vars,
  };
}

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

function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

function timeOf(ts: number): string {
  try {
    return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

interface HoverInfo {
  x: number;
  y: number;
  title: string;
  body: string;
  color: string;
}

export function MindPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Simulation | null>(null);
  const bubblesRef = useRef<Bubble[]>([]);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const paletteRef = useRef<Palette | null>(null);
  const hoverIdRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const alphaRef = useRef(1);
  const drawRef = useRef<() => void>(() => {});
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reducedMotion = usePrefersReducedMotion();
  const [graph, setGraph] = useState<MindGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [live, setLive] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // -- data ------------------------------------------------------------------

  const loadGraph = useCallback(async (signal?: AbortSignal) => {
    try {
      const g = await fetchMindGraph(signal);
      setGraph(g);
      setError(null);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    loadGraph(ctrl.signal);
    return () => ctrl.abort();
  }, [loadGraph]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => loadGraph(), 1500);
  }, [loadGraph]);

  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  // (Re)build the simulation whenever the graph or canvas size changes.
  useEffect(() => {
    if (!graph || size.w === 0) return;
    const sim = createSimulation(graph, size.w, size.h, simRef.current ?? undefined);
    settle(sim, size.w, size.h, reducedMotion ? 400 : 80);
    simRef.current = sim;
    alphaRef.current = reducedMotion ? 0 : 0.6;
    drawRef.current();
  }, [graph, size, reducedMotion]);

  // Live thought stream with reconnect + backoff.
  useEffect(() => {
    const ctrl = new AbortController();
    let attempt = 0;
    let replayed: Thought[] = [];

    const onThought = (t: Thought) => {
      setThoughts((prev) => [t, ...prev.filter((p) => p.id !== t.id)].slice(0, MAX_LIST));
      if (t.replay) {
        replayed.push(t);
        return;
      }
      const { w, h } = sizeRef.current;
      seqRef.current += 1;
      bubblesRef.current = spawnBubble(bubblesRef.current, t, w, h, performance.now(), seqRef.current);
      if (simRef.current) pulseLinked(simRef.current, t.links);
      alphaRef.current = Math.max(alphaRef.current, reducedMotion ? 0 : 0.15);
      if (t.event === 'memory_store') scheduleRefresh();
      drawRef.current();
    };

    const flushReplay = () => {
      // Show the tail of the previous turn as bubbles so the page isn't blank.
      const { w, h } = sizeRef.current;
      for (const t of replayed.slice(-5)) {
        seqRef.current += 1;
        bubblesRef.current = spawnBubble(bubblesRef.current, t, w, h, performance.now(), seqRef.current);
      }
      replayed = [];
      drawRef.current();
    };

    (async () => {
      while (!ctrl.signal.aborted) {
        try {
          setLive('connecting');
          let first = true;
          for await (const t of streamMind(ctrl.signal)) {
            if (first) {
              setLive('live');
              attempt = 0;
              first = false;
            }
            onThought(t);
            if (!t.replay && replayed.length) flushReplay();
          }
          if (replayed.length) flushReplay();
        } catch {
          if (ctrl.signal.aborted) return;
        }
        setLive('offline');
        attempt = Math.min(attempt + 1, 6);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
    })();
    // Replay frames arrive in one burst; flush them shortly after connecting.
    const replayTimer = setInterval(() => replayed.length && flushReplay(), 600);
    return () => {
      ctrl.abort();
      clearInterval(replayTimer);
    };
  }, [reducedMotion, scheduleRefresh]);

  // -- canvas sizing + theme ---------------------------------------------------

  useEffect(() => {
    const el = containerRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;
    const resize = () => {
      const rect = el.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      sizeRef.current = { w, h, dpr };
      setSize({ w, h });
      drawRef.current();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const update = () => {
      paletteRef.current = readPalette();
      drawRef.current();
    };
    update();
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    const mql = window.matchMedia?.('(prefers-color-scheme: dark)');
    mql?.addEventListener?.('change', update);
    return () => {
      mo.disconnect();
      mql?.removeEventListener?.('change', update);
    };
  }, []);

  // -- drawing -----------------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const pal = paletteRef.current;
    if (!canvas || !ctx || !pal) return;
    const { w, h, dpr } = sizeRef.current;
    const now = performance.now();
    const sim = simRef.current;
    const bubbles = bubblesRef.current;
    const hoverId = hoverIdRef.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Soft central glow.
    const bgGlow = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.6);
    bgGlow.addColorStop(0, withAlpha(pal.accent, pal.dark ? 0.1 : 0.06));
    bgGlow.addColorStop(1, withAlpha(pal.accent, 0));
    ctx.fillStyle = bgGlow;
    ctx.fillRect(0, 0, w, h);

    const colorOf = (kind: string) => pal.vars[NODE_COLOR_VAR[kind] ?? '--color-accent'] ?? pal.accent;

    if (sim) {
      // Edges
      ctx.lineWidth = 1;
      for (const [i, j] of sim.links) {
        const a = sim.nodes[i];
        const b = sim.nodes[j];
        const lit = Math.max(a.pulse, b.pulse);
        const hovered = hoverId === a.id || hoverId === b.id;
        ctx.strokeStyle = hovered || lit > 0.05
          ? withAlpha(colorOf(lit > a.pulse ? b.kind : a.kind), 0.25 + 0.5 * Math.max(lit, hovered ? 0.6 : 0))
          : withAlpha(pal.textMuted, pal.dark ? 0.22 : 0.3);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // Nodes
      if (pal.dark) ctx.globalCompositeOperation = 'lighter';
      for (const n of sim.nodes) {
        const color = colorOf(n.kind);
        const glowR = n.r * (2.4 + n.pulse * 2.2);
        const g = ctx.createRadialGradient(n.x, n.y, n.r * 0.3, n.x, n.y, glowR);
        g.addColorStop(0, withAlpha(color, (pal.dark ? 0.45 : 0.28) + n.pulse * 0.4));
        g.addColorStop(1, withAlpha(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      for (const n of sim.nodes) {
        const color = colorOf(n.kind);
        ctx.fillStyle = withAlpha(color, 0.85);
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * (1 + n.pulse * 0.25), 0, Math.PI * 2);
        ctx.fill();
        // specular highlight
        ctx.fillStyle = withAlpha('#ffffff', pal.dark ? 0.35 : 0.5);
        ctx.beginPath();
        ctx.arc(n.x - n.r * 0.3, n.y - n.r * 0.3, n.r * 0.32, 0, Math.PI * 2);
        ctx.fill();
        if (hoverId === n.id) {
          ctx.strokeStyle = withAlpha(pal.text, 0.8);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // Thought bubbles + their links to the memories they used.
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const b of bubbles) {
      const s = bubbleScale(b, now, reducedMotion);
      if (s <= 0) continue;
      const color = pal.vars[THOUGHT_COLOR_VAR[b.type] ?? '--color-accent'] ?? pal.accent;
      const fade = Math.min(1, s);
      if (sim) {
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = withAlpha(color, 0.55 * fade);
        for (const id of b.links) {
          const idx = sim.index.get(id);
          if (idx === undefined) continue;
          const n = sim.nodes[idx];
          ctx.beginPath();
          ctx.moveTo(b.x, b.y);
          ctx.lineTo(n.x, n.y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      const r = b.r * Math.max(s, 0.01);
      const g = ctx.createRadialGradient(b.x, b.y, r * 0.2, b.x, b.y, r * 2.2);
      g.addColorStop(0, withAlpha(color, 0.35 * fade));
      g.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, r * 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = withAlpha(color, (pal.dark ? 0.2 : 0.14) * fade);
      ctx.strokeStyle = withAlpha(color, 0.9 * fade);
      ctx.lineWidth = hoverId === b.id ? 2 : 1.2;
      ctx.beginPath();
      ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = withAlpha(pal.text, 0.85 * fade);
      ctx.fillText(clip(b.text, 30), b.x, b.y + r + 4);
    }
  }, [reducedMotion]);

  useEffect(() => {
    drawRef.current = draw;
    draw();
  }, [draw]);

  // Animation loop (skipped entirely under prefers-reduced-motion).
  useEffect(() => {
    if (reducedMotion) {
      // Still expire bubbles and fade pulses, just without continuous motion.
      const id = setInterval(() => {
        const now = performance.now();
        bubblesRef.current = bubblesRef.current.filter((b) => now - b.born < BUBBLE_LIFETIME_MS);
        if (simRef.current) decayPulses(simRef.current, 1000);
        drawRef.current();
      }, 1000);
      return () => clearInterval(id);
    }
    let raf = 0;
    let last = performance.now();
    const frame = (t: number) => {
      const dt = Math.min(64, t - last);
      last = t;
      const { w, h } = sizeRef.current;
      const sim = simRef.current;
      if (sim && w > 0) {
        // Cool down to a gentle "breathing" level instead of freezing.
        alphaRef.current = Math.max(0.03, alphaRef.current * 0.985);
        tick(sim, w, h, alphaRef.current);
        decayPulses(sim, dt);
      }
      bubblesRef.current = stepBubbles(bubblesRef.current, t, w, h);
      drawRef.current();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion]);

  // -- hover -------------------------------------------------------------------

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = hitTest(simRef.current, bubblesRef.current, x, y);
    const pal = paletteRef.current;
    const newId = hit ? (hit.kind === 'node' ? hit.node.id : hit.bubble.id) : null;
    if (newId !== hoverIdRef.current) {
      hoverIdRef.current = newId;
      drawRef.current();
    }
    if (!hit || !pal) {
      setHover(null);
      return;
    }
    if (hit.kind === 'node') {
      const n = hit.node;
      setHover({
        x,
        y,
        title: NODE_KIND_LABEL[n.kind] ?? n.kind,
        body: n.text || n.label,
        color: pal.vars[NODE_COLOR_VAR[n.kind] ?? '--color-accent'] ?? pal.accent,
      });
    } else {
      const b = hit.bubble;
      setHover({
        x,
        y,
        title: `${THOUGHT_LABEL[b.type] ?? 'Thought'} · ${timeOf(b.ts)}`,
        body: b.text,
        color: pal.vars[THOUGHT_COLOR_VAR[b.type] ?? '--color-accent'] ?? pal.accent,
      });
    }
  };

  const onPointerLeave = () => {
    hoverIdRef.current = null;
    setHover(null);
    drawRef.current();
  };

  // -- render ------------------------------------------------------------------

  const nodeCount = graph?.nodes.length ?? 0;
  const edgeCount = graph?.edges.length ?? 0;
  const empty = !loading && !error && nodeCount === 0;
  const kinds = graph?.stats?.kinds ?? {};

  return (
    <div className="flex-1 flex flex-col overflow-hidden px-4 md:px-6 py-6">
      <header className="mb-4 shrink-0 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Brain size={18} style={{ color: 'var(--color-accent)' }} />
          <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
            Mind
          </h1>
          <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
            {nodeCount} memories · {edgeCount} links
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{
                background:
                  live === 'live'
                    ? 'var(--color-success)'
                    : live === 'connecting'
                      ? 'var(--color-warning)'
                      : 'var(--color-text-tertiary)',
              }}
            />
            {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
          </span>
          <button
            onClick={() => {
              setLoading(true);
              loadGraph();
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
            style={{
              background: 'var(--color-bg-secondary)',
              color: 'var(--color-text-secondary)',
              border: '1px solid var(--color-border)',
            }}
          >
            <RefreshCw size={12} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} /> Refresh
          </button>
        </div>
      </header>

      <div className="flex-1 flex flex-col lg:flex-row gap-4 min-h-0">
        <div
          ref={containerRef}
          className="relative flex-1 min-h-[320px] rounded-2xl overflow-hidden"
          style={{
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border)',
          }}
        >
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`Memory web with ${nodeCount} memories and ${edgeCount} connections`}
            className="absolute inset-0 block"
            onPointerMove={onPointerMove}
            onPointerLeave={onPointerLeave}
            style={{ cursor: hover ? 'pointer' : 'default' }}
          />

          {empty && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6 pointer-events-none">
              <Brain size={32} style={{ color: 'var(--color-accent)', opacity: 0.6 }} />
              <p className="mt-3 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                No memories yet — chat with Jarvis and they'll appear here
              </p>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
              <p className="text-sm" style={{ color: 'var(--color-error)' }}>
                Couldn't load memories: {error}
              </p>
              <button
                onClick={() => {
                  setLoading(true);
                  loadGraph();
                }}
                className="mt-3 px-3 py-1.5 rounded-lg text-xs cursor-pointer"
                style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text)' }}
              >
                Try again
              </button>
            </div>
          )}

          {hover && (
            <div
              className="absolute z-10 max-w-xs rounded-lg px-3 py-2 text-xs shadow-lg pointer-events-none"
              style={{
                left: Math.min(hover.x + 14, Math.max(0, size.w - 300)),
                top: Math.min(hover.y + 14, Math.max(0, size.h - 120)),
                background: 'var(--color-surface)',
                color: 'var(--color-text)',
                border: `1px solid ${withAlpha(hover.color, 0.5)}`,
              }}
            >
              <div className="font-medium mb-1" style={{ color: hover.color }}>
                {hover.title}
              </div>
              <div className="whitespace-pre-wrap break-words" style={{ color: 'var(--color-text-secondary)' }}>
                {clip(hover.body, 600)}
              </div>
            </div>
          )}

          <div className="absolute left-3 bottom-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] pointer-events-none">
            {Object.entries(NODE_COLOR_VAR).map(([kind, cssVar]) => (
              <span key={kind} className="flex items-center gap-1" style={{ color: 'var(--color-text-tertiary)' }}>
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: `var(${cssVar})` }} />
                {NODE_KIND_LABEL[kind]?.split(' (')[0]}
                {kinds[kind] ? ` ${kinds[kind]}` : ''}
              </span>
            ))}
          </div>
        </div>

        <aside
          className="lg:w-72 shrink-0 rounded-2xl flex flex-col min-h-0 max-h-64 lg:max-h-none"
          style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)' }}
        >
          <div
            className="px-4 py-3 text-xs font-medium uppercase tracking-wide"
            style={{ color: 'var(--color-text-tertiary)', borderBottom: '1px solid var(--color-border)' }}
          >
            Live thoughts
          </div>
          <ol className="flex-1 overflow-y-auto px-3 py-2 space-y-2" aria-live="polite">
            {thoughts.length === 0 && (
              <li className="text-xs px-1 py-2" style={{ color: 'var(--color-text-tertiary)' }}>
                Ask Jarvis something — each step of its thinking will pop up here and in the web.
              </li>
            )}
            {thoughts.map((t) => (
              <li key={t.id} className="flex gap-2 text-xs leading-snug">
                <span
                  className="mt-1 inline-block w-2 h-2 rounded-full shrink-0"
                  style={{ background: `var(${THOUGHT_COLOR_VAR[t.type] ?? '--color-accent'})` }}
                />
                <div className="min-w-0">
                  <div style={{ color: 'var(--color-text)' }} className="break-words">
                    {clip(t.text, 240)}
                  </div>
                  <div style={{ color: 'var(--color-text-tertiary)' }}>
                    {THOUGHT_LABEL[t.type] ?? t.type} · {timeOf(t.ts)}
                    {t.links.length > 0 ? ` · ${t.links.length} linked` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}
