/**
 * Canvas renderer for the Graphify-style knowledge graph. Drag the background
 * to pan, scroll to zoom, drag a dot to move it, hover to light up its
 * neighbours, click to select. All layout maths lives in lib/graph.ts.
 */
import { useCallback, useEffect, useRef } from 'react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import {
  fitCamera,
  GRAPH_BG,
  pickNode,
  searchNodes,
  settleLayout,
  stepLayout,
  toScreen,
  toWorld,
  zoomAt,
  type Camera,
  type GNode,
  type GraphModel,
} from '../../lib/graph';

const FLASH_MS = 2600;

interface Props {
  model: GraphModel | null;
  hidden?: Set<string>;
  query?: string;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  flashes?: React.MutableRefObject<Map<string, number>>;
  /** Small embedded view (Jarvis page): fewer labels, no zoom buttons. */
  compact?: boolean;
  /** Pulse the newest thought (Jarvis is thinking or speaking). */
  active?: boolean;
  reducedMotion?: boolean;
}

function rgba(hex: string, a: number): string {
  const v = hex.replace('#', '');
  const n = parseInt(v.length === 3 ? v.split('').map((c) => c + c).join('') : v, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function KnowledgeGraph({
  model,
  hidden,
  query = '',
  selectedId = null,
  onSelect,
  flashes,
  compact = false,
  active = false,
  reducedMotion = false,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const camRef = useRef<Camera>({ x: 0, y: 0, k: 1 });
  const fittedRef = useRef(false);
  const alphaRef = useRef(1);
  const hoverRef = useRef(-1);
  const rafRef = useRef(0);
  const modelRef = useRef<GraphModel | null>(null);
  const propsRef = useRef({ hidden, query, selectedId, compact, active, reducedMotion });
  propsRef.current = { hidden, query, selectedId, compact, active, reducedMotion };
  const dragRef = useRef<{ mode: 'pan' | 'node'; node: number; sx: number; sy: number; moved: boolean; cam: Camera } | null>(null);

  const visible = useCallback((n: GNode) => !propsRef.current.hidden?.has(n.community), []);

  // ── drawing ────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const m = modelRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h, dpr } = sizeRef.current;
    const cam = camRef.current;
    const p = propsRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = GRAPH_BG;
    ctx.fillRect(0, 0, w, h);
    if (!m || m.nodes.length === 0) return;

    const now = performance.now();
    const selected = p.selectedId ? m.index.get(p.selectedId) ?? -1 : -1;
    const focusIdx = hoverRef.current >= 0 ? hoverRef.current : selected;
    const focus = new Set<number>();
    const focusLabels = new Set<number>();
    if (focusIdx >= 0) {
      focus.add(focusIdx);
      focusLabels.add(focusIdx);
      for (const j of m.neighbors[focusIdx]) focus.add(j);
      // Label only the best-connected neighbours so a hub doesn't bury itself in text.
      [...m.neighbors[focusIdx]]
        .sort((x, y) => m.nodes[y].degree - m.nodes[x].degree)
        .slice(0, 10)
        .forEach((j) => focusLabels.add(j));
    }
    const matches = new Set(searchNodes(m, p.query));
    const dimming = focus.size > 0 || matches.size > 0;
    const lit = (i: number) => (focus.size > 0 ? focus.has(i) : matches.size > 0 ? matches.has(i) : true);
    const pos = m.nodes.map((n) => toScreen(cam, w, h, n.x, n.y));
    const lineW = Math.max(0.45, Math.min(1.4, 0.7 * Math.sqrt(cam.k)));

    // Edges: thin, slightly curved, tinted by the source node's community.
    for (const e of m.edges) {
      const a = m.nodes[e.a];
      const b = m.nodes[e.b];
      if (!visible(a) || !visible(b)) continue;
      const pa = pos[e.a];
      const pb = pos[e.b];
      const incident = focus.size > 0 && (e.a === focusIdx || e.b === focusIdx);
      const alpha = incident ? 0.85 : dimming ? 0.05 : e.kind === 'recall' ? 0.5 : 0.28;
      const mx = (pa.x + pb.x) / 2;
      const my = (pa.y + pb.y) / 2;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.quadraticCurveTo(mx - dy * 0.12, my + dx * 0.12, pb.x, pb.y);
      ctx.strokeStyle = rgba(a.color, alpha);
      ctx.lineWidth = incident ? lineW * 1.6 : lineW;
      if (e.kind === 'next') ctx.setLineDash([3, 3]);
      ctx.stroke();
      if (e.kind === 'next') ctx.setLineDash([]);
    }

    // Nodes: small flat dots; hubs are bigger because they have more links.
    let newestThought = -1;
    m.nodes.forEach((n, i) => {
      if (n.thought) newestThought = i;
    });
    m.nodes.forEach((n, i) => {
      if (!visible(n)) return;
      const q = pos[i];
      if (q.x < -20 || q.y < -20 || q.x > w + 20 || q.y > h + 20) return;
      const r = Math.max(1.6, Math.min(18, n.r * Math.sqrt(cam.k)));
      ctx.beginPath();
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(n.color, dimming && !lit(i) ? 0.12 : 1);
      ctx.fill();
      if (i === selected || i === hoverRef.current) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
      // A recalled memory (or a brand-new thought) sends out a ring.
      const at = flashes?.current.get(n.id);
      if (at !== undefined && now - at < FLASH_MS) {
        const t = (now - at) / FLASH_MS;
        ctx.beginPath();
        ctx.arc(q.x, q.y, r + 2 + t * 14, 0, Math.PI * 2);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = rgba(n.color, 0.9 * (1 - t));
        ctx.stroke();
      }
      if (p.active && i === newestThought && !p.reducedMotion) {
        const t = (now % 1400) / 1400;
        ctx.beginPath();
        ctx.arc(q.x, q.y, r + 2 + t * 10, 0, Math.PI * 2);
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgba(n.color, 0.7 * (1 - t));
        ctx.stroke();
      }
    });

    // Labels: hubs, whatever is focused or matched, and everything when zoomed in.
    ctx.font = '11px ui-sans-serif, system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    let budget = p.compact ? 8 : 60;
    m.nodes.forEach((n, i) => {
      if (budget <= 0 || !visible(n)) return;
      const show =
        focusLabels.has(i) ||
        (matches.has(i) && matches.size <= 30) ||
        (n.hub && !dimming && (!p.compact || cam.k > 0.5)) ||
        (!p.compact && cam.k > 2.2 && !dimming);
      if (!show) return;
      const q = pos[i];
      if (q.x < 0 || q.y < 0 || q.x > w || q.y > h) return;
      budget -= 1;
      const r = Math.max(1.6, Math.min(18, n.r * Math.sqrt(cam.k)));
      const text = n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(14, 16, 24, 0.9)';
      ctx.strokeText(text, q.x + r + 4, q.y);
      ctx.fillStyle = 'rgba(232, 234, 242, 0.92)';
      ctx.fillText(text, q.x + r + 4, q.y);
    });
  }, [flashes, visible]);

  // ── animation loop ─────────────────────────────────────────────────────
  const loop = useCallback(() => {
    rafRef.current = 0;
    const m = modelRef.current;
    const p = propsRef.current;
    let again = false;
    if (m && !p.reducedMotion && alphaRef.current > 0.02) {
      stepLayout(m, alphaRef.current);
      alphaRef.current *= 0.985;
      again = true;
    }
    if (flashes) {
      const now = performance.now();
      for (const t of flashes.current.values()) if (now - t < FLASH_MS) again = true;
    }
    if (p.active && !p.reducedMotion) again = true;
    if (dragRef.current) again = true;
    draw();
    if (again) rafRef.current = requestAnimationFrame(loop);
  }, [draw, flashes]);

  const kick = useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(loop);
  }, [loop]);

  // New model: keep positions, settle new nodes, fit on first load.
  useEffect(() => {
    const prev = modelRef.current;
    modelRef.current = model;
    if (!model) return kick();
    if (!prev || prev.nodes.length === 0) settleLayout(model, propsRef.current.reducedMotion ? 400 : 220);
    alphaRef.current = propsRef.current.reducedMotion ? 0 : prev ? 0.25 : 0.4;
    const { w, h } = sizeRef.current;
    if ((!fittedRef.current || compact) && w > 0 && model.nodes.length > 0) {
      camRef.current = fitCamera(model.nodes, w, h, visible);
      fittedRef.current = true;
    }
    kick();
  }, [model, kick, visible, compact]);

  useEffect(() => kick(), [hidden, query, selectedId, active, kick]);

  // Flashes are written outside React; poll lightly so rings start promptly.
  useEffect(() => {
    if (!flashes) return;
    const id = window.setInterval(kick, 400);
    return () => window.clearInterval(id);
  }, [flashes, kick]);

  // Size the canvas to its box (crisp on Retina).
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const first = sizeRef.current.w === 0;
      sizeRef.current = { w, h, dpr };
      const m = modelRef.current;
      if (m && m.nodes.length && (first || !fittedRef.current || propsRef.current.compact)) {
        camRef.current = fitCamera(m.nodes, w, h, visible);
        fittedRef.current = true;
      }
      kick();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [kick, visible]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // ── interaction ────────────────────────────────────────────────────────
  const localPoint = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const m = modelRef.current;
    if (!m) return;
    const { w, h } = sizeRef.current;
    const pt = localPoint(e);
    const hit = pickNode(m, camRef.current, w, h, pt.x, pt.y, visible);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { mode: hit >= 0 ? 'node' : 'pan', node: hit, sx: pt.x, sy: pt.y, moved: false, cam: { ...camRef.current } };
    if (hit >= 0) m.nodes[hit].fixed = true;
    kick();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const m = modelRef.current;
    if (!m) return;
    const { w, h } = sizeRef.current;
    const pt = localPoint(e);
    const drag = dragRef.current;
    if (drag) {
      if (Math.hypot(pt.x - drag.sx, pt.y - drag.sy) > 3) drag.moved = true;
      if (drag.mode === 'pan') {
        camRef.current = {
          ...drag.cam,
          x: drag.cam.x - (pt.x - drag.sx) / drag.cam.k,
          y: drag.cam.y - (pt.y - drag.sy) / drag.cam.k,
        };
      } else {
        const world = toWorld(camRef.current, w, h, pt.x, pt.y);
        m.nodes[drag.node].x = world.x;
        m.nodes[drag.node].y = world.y;
        alphaRef.current = Math.max(alphaRef.current, 0.15);
      }
      kick();
      return;
    }
    const hit = pickNode(m, camRef.current, w, h, pt.x, pt.y, visible);
    if (hit !== hoverRef.current) {
      hoverRef.current = hit;
      canvasRef.current!.style.cursor = hit >= 0 ? 'pointer' : 'grab';
      kick();
    }
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    const m = modelRef.current;
    dragRef.current = null;
    if (!drag || !m) return;
    if (drag.node >= 0) m.nodes[drag.node].fixed = false;
    if (!drag.moved) onSelect?.(drag.node >= 0 ? m.nodes[drag.node].id : null);
    kick();
  };

  const onWheel = (e: React.WheelEvent) => {
    const { w, h } = sizeRef.current;
    const pt = localPoint(e);
    camRef.current = zoomAt(camRef.current, w, h, pt.x, pt.y, Math.exp(-e.deltaY * 0.0015));
    kick();
  };

  const zoomBy = (f: number) => {
    const { w, h } = sizeRef.current;
    camRef.current = zoomAt(camRef.current, w, h, w / 2, h / 2, f);
    kick();
  };
  const fit = () => {
    const m = modelRef.current;
    const { w, h } = sizeRef.current;
    if (m) camRef.current = fitCamera(m.nodes, w, h, visible);
    kick();
  };

  const btn = 'w-7 h-7 flex items-center justify-center rounded-md cursor-pointer';
  const btnStyle = { background: 'rgba(30, 33, 46, 0.85)', color: '#c8ccd8', border: '1px solid rgba(255,255,255,0.08)' };

  return (
    <div ref={wrapRef} className="relative w-full h-full overflow-hidden" style={{ background: GRAPH_BG }}>
      <canvas
        ref={canvasRef}
        className="block touch-none"
        style={{ cursor: 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          if (!dragRef.current && hoverRef.current !== -1) {
            hoverRef.current = -1;
            kick();
          }
        }}
        onWheel={onWheel}
        aria-label="Knowledge graph of Jarvis's memories"
        role="img"
      />
      {!compact && (
        <div className="absolute left-3 bottom-3 flex flex-col gap-1">
          <button className={btn} style={btnStyle} onClick={() => zoomBy(1.3)} title="Zoom in"><Plus size={14} /></button>
          <button className={btn} style={btnStyle} onClick={() => zoomBy(1 / 1.3)} title="Zoom out"><Minus size={14} /></button>
          <button className={btn} style={btnStyle} onClick={fit} title="Fit to screen"><Maximize2 size={13} /></button>
        </div>
      )}
    </div>
  );
}
