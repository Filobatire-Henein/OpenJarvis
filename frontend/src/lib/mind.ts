// Mind page: data access + a tiny dependency-free force layout.
//
// Everything here talks only to the local OpenJarvis server (getBase()).
// The layout/bubble helpers are pure so they can be unit-tested and so the
// canvas component stays a thin render loop.

import { apiFetch, authHeaders, getBase } from './api';

export type MindNodeKind = 'fact' | 'doc' | 'entity' | 'note' | string;
export type ThoughtType = 'thought' | 'tool' | 'memory_hit' | 'answer';

export interface MindNode {
  id: string;
  label: string;
  kind: MindNodeKind;
  weight: number;
  created_at: number;
  text?: string;
}

export interface MindEdge {
  source: string;
  target: string;
  kind: string;
}

export interface MindGraph {
  nodes: MindNode[];
  edges: MindEdge[];
  stats?: { nodes: number; edges: number; kinds?: Record<string, number>; build_ms?: number };
}

export interface Thought {
  id: string;
  type: ThoughtType;
  event?: string;
  text: string;
  links: string[];
  ts: number;
  replay?: boolean;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function fetchMindGraph(signal?: AbortSignal): Promise<MindGraph> {
  const res = await apiFetch('/v1/mind/graph', { signal });
  if (!res.ok) throw new Error(`Mind graph request failed: ${res.status}`);
  const body = (await res.json()) as MindGraph;
  return { nodes: body.nodes ?? [], edges: body.edges ?? [], stats: body.stats };
}

/** Split an SSE text buffer into complete `data:` payloads + the remainder. */
export function parseSSE(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  const frames = buffer.split('\n\n');
  const rest = frames.pop() ?? '';
  for (const frame of frames) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) payloads.push(data);
  }
  return { payloads, rest };
}

/** Live thought stream. Yields until the signal aborts or the server closes. */
export async function* streamMind(signal: AbortSignal): AsyncGenerator<Thought> {
  const res = await fetch(`${getBase()}/v1/mind/stream`, {
    headers: authHeaders({ Accept: 'text/event-stream' }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Mind stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const { payloads, rest } = parseSSE(buffer);
      buffer = rest;
      for (const payload of payloads) {
        try {
          yield JSON.parse(payload) as Thought;
        } catch {
          // ignore malformed frames
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface SimNode extends MindNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** 0..1 glow boost when a thought recalls this memory; decays over time. */
  pulse: number;
}

export interface Simulation {
  nodes: SimNode[];
  links: Array<[number, number]>;
  index: Map<string, number>;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function nodeRadius(weight: number): number {
  const w = Number.isFinite(weight) ? Math.min(Math.max(weight, 0), 1) : 0;
  return 4 + Math.sqrt(w) * 12;
}

/** Deterministic phyllotaxis seed position (no Math.random → stable tests). */
export function seedPosition(i: number, width: number, height: number) {
  const radius = 14 * Math.sqrt(i + 0.5);
  const angle = i * GOLDEN_ANGLE;
  return { x: width / 2 + radius * Math.cos(angle), y: height / 2 + radius * Math.sin(angle) };
}

/**
 * Build (or rebuild) a simulation. Nodes that already exist in `previous`
 * keep their position so a refreshed graph doesn't jump around.
 */
export function createSimulation(
  graph: MindGraph,
  width: number,
  height: number,
  previous?: Simulation,
): Simulation {
  const nodes: SimNode[] = graph.nodes.map((n, i) => {
    const old = previous ? previous.nodes[previous.index.get(n.id) ?? -1] : undefined;
    const pos = old ?? seedPosition(i, width, height);
    return {
      ...n,
      x: pos.x,
      y: pos.y,
      vx: old?.vx ?? 0,
      vy: old?.vy ?? 0,
      r: nodeRadius(n.weight),
      pulse: old?.pulse ?? 0,
    };
  });
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const links: Array<[number, number]> = [];
  for (const e of graph.edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a !== undefined && b !== undefined && a !== b) links.push([a, b]);
  }
  return { nodes, links, index };
}

/** One step of a simple force layout. Returns the total kinetic energy. */
export function tick(sim: Simulation, width: number, height: number, alpha = 1): number {
  const { nodes, links } = sim;
  const n = nodes.length;
  const cx = width / 2;
  const cy = height / 2;
  const repulse = 900 * alpha;

  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        // Coincident nodes: nudge apart deterministically.
        dx = (i - j) * 0.1;
        dy = 0.1;
        d2 = dx * dx + dy * dy;
      }
      if (d2 > 160000) continue; // ignore far pairs (400px)
      const f = repulse / d2;
      const d = Math.sqrt(d2);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  for (const [i, j] of links) {
    const a = nodes[i];
    const b = nodes[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const rest = 46 + a.r + b.r;
    const k = 0.02 * alpha * (d - rest);
    const fx = (dx / d) * k;
    const fy = (dy / d) * k;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  let energy = 0;
  const margin = 12;
  for (const p of nodes) {
    p.vx += (cx - p.x) * 0.004 * alpha;
    p.vy += (cy - p.y) * 0.004 * alpha;
    p.vx *= 0.82;
    p.vy *= 0.82;
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > 12) {
      p.vx = (p.vx / speed) * 12;
      p.vy = (p.vy / speed) * 12;
    }
    p.x = Math.min(width - margin - p.r, Math.max(margin + p.r, p.x + p.vx));
    p.y = Math.min(height - margin - p.r, Math.max(margin + p.r, p.y + p.vy));
    energy += p.vx * p.vx + p.vy * p.vy;
  }
  return energy;
}

/** Run the layout to rest (used for reduced motion and first paint). */
export function settle(sim: Simulation, width: number, height: number, maxSteps = 300): void {
  for (let s = 0; s < maxSteps; s++) {
    const alpha = 1 - s / maxSteps;
    if (tick(sim, width, height, Math.max(alpha, 0.1)) < 0.01 * Math.max(sim.nodes.length, 1)) {
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Thought bubbles
// ---------------------------------------------------------------------------

export interface Bubble extends Thought {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  born: number;
}

export const BUBBLE_LIFETIME_MS = 14000;
export const MAX_BUBBLES = 12;

/**
 * Add a bubble for `thought` near the centre, offset by a deterministic
 * angle so consecutive bubbles fan out. Keeps at most MAX_BUBBLES.
 */
export function spawnBubble(
  bubbles: Bubble[],
  thought: Thought,
  width: number,
  height: number,
  now: number,
  seq: number,
): Bubble[] {
  const angle = seq * GOLDEN_ANGLE;
  const dist = 30 + (seq % 4) * 12;
  const r = thought.type === 'answer' ? 22 : thought.type === 'memory_hit' ? 16 : 13;
  const bubble: Bubble = {
    ...thought,
    x: width / 2 + Math.cos(angle) * dist,
    y: height / 2 + Math.sin(angle) * dist,
    vx: Math.cos(angle) * 0.6,
    vy: Math.sin(angle) * 0.6 - 0.15,
    r,
    born: now,
  };
  const next = [...bubbles.filter((b) => b.id !== thought.id), bubble];
  return next.slice(Math.max(0, next.length - MAX_BUBBLES));
}

/** Drift bubbles, drop expired ones. */
export function stepBubbles(bubbles: Bubble[], now: number, width: number, height: number): Bubble[] {
  const alive = bubbles.filter((b) => now - b.born < BUBBLE_LIFETIME_MS);
  for (const b of alive) {
    b.x = Math.min(width - b.r, Math.max(b.r, b.x + b.vx));
    b.y = Math.min(height - b.r, Math.max(b.r, b.y + b.vy));
    b.vx *= 0.985;
    b.vy = b.vy * 0.985 - 0.004; // gentle upward float
  }
  return alive;
}

/** 0..1 visual scale: quick pop-in, hold, fade-out at end of life. */
export function bubbleScale(b: Bubble, now: number, reducedMotion = false): number {
  const age = now - b.born;
  if (age < 0) return 0;
  const fadeStart = BUBBLE_LIFETIME_MS - 2500;
  const fade = age > fadeStart ? Math.max(0, 1 - (age - fadeStart) / 2500) : 1;
  if (reducedMotion) return fade;
  const t = Math.min(1, age / 350);
  // easeOutBack for a soft "pop"
  const c1 = 1.70158;
  const pop = 1 + (c1 + 1) * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  return pop * fade;
}

/** Light up memory nodes a thought linked to. Returns how many matched. */
export function pulseLinked(sim: Simulation, links: string[]): number {
  let hits = 0;
  for (const id of links) {
    const i = sim.index.get(id);
    if (i !== undefined) {
      sim.nodes[i].pulse = 1;
      hits++;
    }
  }
  return hits;
}

export function decayPulses(sim: Simulation, dtMs: number): void {
  const k = Math.exp(-dtMs / 1800);
  for (const n of sim.nodes) n.pulse = n.pulse < 0.01 ? 0 : n.pulse * k;
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

export type HitTarget = { kind: 'node'; node: SimNode } | { kind: 'bubble'; bubble: Bubble };

export function hitTest(
  sim: Simulation | null,
  bubbles: Bubble[],
  x: number,
  y: number,
): HitTarget | null {
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    if (Math.hypot(b.x - x, b.y - y) <= b.r + 3) return { kind: 'bubble', bubble: b };
  }
  if (!sim) return null;
  let best: SimNode | null = null;
  let bestD = Infinity;
  for (const n of sim.nodes) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d <= n.r + 4 && d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best ? { kind: 'node', node: best } : null;
}

// ---------------------------------------------------------------------------
// Colour helpers (theme colours come from CSS variables)
// ---------------------------------------------------------------------------

/** Return `color` (hex or rgb[a]) with the given alpha as an rgba() string. */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  const a = Math.min(Math.max(alpha, 0), 1);
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) {
    const [r, g, b] = m[1].split('').map((h) => parseInt(h + h, 16));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(c);
  if (m) {
    const v = m[1];
    return `rgba(${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)}, ${a})`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${a})`;
  return c || `rgba(128, 128, 128, ${a})`;
}

export const NODE_COLOR_VAR: Record<string, string> = {
  fact: '--color-accent',
  doc: '--color-accent-purple',
  entity: '--color-accent-amber',
  note: '--color-success',
};

export const THOUGHT_COLOR_VAR: Record<ThoughtType, string> = {
  thought: '--color-accent',
  tool: '--color-accent-amber',
  memory_hit: '--color-accent-purple',
  answer: '--color-success',
};

export const NODE_KIND_LABEL: Record<string, string> = {
  fact: 'Remembered fact',
  doc: 'Stored memory',
  entity: 'Knowledge-graph entity',
  note: 'Note (MEMORY.md / USER.md)',
};
