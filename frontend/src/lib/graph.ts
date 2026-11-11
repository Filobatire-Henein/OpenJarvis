/**
 * Graphify-style knowledge graph: memories become small dots coloured by the
 * community they belong to, joined by thin curved lines, laid out by a force
 * simulation in world space and viewed through a pan/zoom camera.
 *
 * Live thoughts are added as nodes of their own ("Thoughts" community), wired
 * to the memories they recalled, so you can see what each answer drew on.
 *
 * Everything here is pure (no DOM) so it can be unit-tested; the canvas
 * component only draws what this module computes.
 */
import type { MindGraph, Thought } from './mind';

/** Tableau 10 -- the categorical palette Graphify-style graphs use. */
export const COMMUNITY_COLORS = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
];
export const THOUGHT_COLOR = '#e8eaf2';
export const THOUGHTS_COMMUNITY = 'thoughts';
export const GRAPH_BG = '#0e1018';

export interface GNode {
  id: string;
  label: string;
  text: string;
  kind: string;
  community: string;
  color: string;
  degree: number;
  r: number;
  hub: boolean;
  thought?: Thought;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed?: boolean;
}

export interface GEdge {
  a: number;
  b: number;
  kind: string;
}

export interface Community {
  id: string;
  name: string;
  color: string;
  size: number;
}

export interface GraphModel {
  nodes: GNode[];
  edges: GEdge[];
  index: Map<string, number>;
  communities: Community[];
  neighbors: number[][];
}

const THOUGHT_LABEL: Record<string, string> = {
  thought: 'Thinking',
  tool: 'Tool',
  memory_hit: 'Recall',
  answer: 'Answer',
};

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

type WeightedAdj = Array<Map<number, number>>;

/** Louvain local moving: each node joins the neighbouring community that most raises modularity. */
function localMove(adj: WeightedAdj, order: number[]): number[] {
  const comm = adj.map((_, i) => i);
  const k = adj.map((nb) => {
    let sum = 0;
    for (const w of nb.values()) sum += w;
    return sum;
  });
  const m2 = k.reduce((x, y) => x + y, 0);
  if (m2 === 0) return comm;
  const tot = k.slice(); // total degree inside each community
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (const i of order) {
      if (k[i] === 0) continue;
      const own = comm[i];
      tot[own] -= k[i];
      const links = new Map<number, number>();
      for (const [j, w] of adj[i]) {
        if (j !== i) links.set(comm[j], (links.get(comm[j]) ?? 0) + w);
      }
      let best = own;
      let bestGain = (links.get(own) ?? 0) - (k[i] * tot[own]) / m2;
      for (const [c, kin] of links) {
        const gain = kin - (k[i] * tot[c]) / m2;
        if (gain > bestGain + 1e-9) {
          best = c;
          bestGain = gain;
        }
      }
      comm[i] = best;
      tot[best] += k[i];
      if (best !== own) moved = true;
    }
    if (!moved) break;
  }
  return comm;
}

/**
 * Community detection with Louvain (the method family Graphify uses): local
 * moving, then fold each community into one node and repeat, so small
 * fragments merge into the clusters you actually see. Deterministic: nodes
 * are visited in id order. Returns a community number per node.
 */
export function detectCommunities(ids: string[], adjacency: number[][]): number[] {
  let adj: WeightedAdj = adjacency.map((nb, i) => {
    const m = new Map<number, number>();
    for (const j of nb) if (j !== i) m.set(j, (m.get(j) ?? 0) + 1);
    return m;
  });
  let order = ids.map((_, i) => i).sort((a, b) => (ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : 0));
  let membership = ids.map((_, i) => i);
  for (let level = 0; level < 12; level++) {
    const comm = localMove(adj, order);
    const remap = new Map<number, number>();
    for (const i of order) if (!remap.has(comm[i])) remap.set(comm[i], remap.size);
    if (remap.size === adj.length) break; // nothing merged: done
    membership = membership.map((s) => remap.get(comm[s])!);
    const next: WeightedAdj = Array.from({ length: remap.size }, () => new Map<number, number>());
    adj.forEach((nb, i) => {
      const ci = remap.get(comm[i])!;
      for (const [j, w] of nb) {
        const cj = remap.get(comm[j])!;
        next[ci].set(cj, (next[ci].get(cj) ?? 0) + w);
      }
    });
    adj = next;
    order = next.map((_, i) => i);
  }
  return membership;
}

export function nodeRadiusForDegree(degree: number): number {
  return Math.min(12, 2.6 + Math.sqrt(degree) * 1.6);
}

/**
 * Turn the server graph (+ recent thoughts) into a coloured, grouped model.
 * Positions from `previous` are kept so a refresh never makes the graph jump.
 */
export function buildGraphModel(graph: MindGraph, thoughts: Thought[] = [], previous?: GraphModel): GraphModel {
  const nodes: GNode[] = graph.nodes.map((n) => ({
    id: n.id,
    label: clip(n.label || n.text || n.id, 48),
    text: n.text || n.label || '',
    kind: n.kind,
    community: '',
    color: COMMUNITY_COLORS[0],
    degree: 0,
    r: 3,
    hub: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
  }));
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const edges: GEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (a: number, b: number, kind: string) => {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ a, b, kind });
  };
  for (const e of graph.edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a !== undefined && b !== undefined) addEdge(a, b, e.kind);
  }

  // Communities over memories only, so thoughts never merge clusters.
  const memCount = nodes.length;
  const memAdj: number[][] = nodes.map(() => []);
  for (const e of edges) {
    memAdj[e.a].push(e.b);
    memAdj[e.b].push(e.a);
  }
  const labels = detectCommunities(nodes.map((n) => n.id), memAdj);
  const groups = new Map<number, number[]>();
  labels.forEach((l, i) => {
    const key = memAdj[i].length === 0 ? -1 : l; // all loners share one group
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(i);
  });
  const ordered = [...groups.entries()]
    .filter(([key]) => key !== -1)
    .sort((x, y) => y[1].length - x[1].length || x[0] - y[0]);
  const communities: Community[] = [];
  ordered.forEach(([, members], ci) => {
    // Name a community after its most connected member, as Graphify does.
    const hub = members.reduce((best, i) => (memAdj[i].length > memAdj[best].length ? i : best), members[0]);
    const id = `c${ci}`;
    const color = COMMUNITY_COLORS[ci % COMMUNITY_COLORS.length];
    communities.push({ id, name: clip(nodes[hub].label, 28), color, size: members.length });
    for (const i of members) {
      nodes[i].community = id;
      nodes[i].color = color;
    }
  });
  const loners = groups.get(-1);
  if (loners?.length) {
    const color = COMMUNITY_COLORS[communities.length % COMMUNITY_COLORS.length];
    communities.push({ id: 'loose', name: 'Unconnected', color, size: loners.length });
    for (const i of loners) {
      nodes[i].community = 'loose';
      nodes[i].color = color;
    }
  }

  // Thoughts: newest last, each wired to the memories it used and to the
  // thought before it, so a turn reads as a little trail through the graph.
  let prevThought = -1;
  const ordering = [...thoughts].sort((a, b) => a.ts - b.ts);
  for (const t of ordering) {
    const id = `t:${t.id}`;
    if (index.has(id)) continue;
    const i = nodes.length;
    nodes.push({
      id,
      label: `${THOUGHT_LABEL[t.type] ?? 'Thought'}: ${clip(t.text, 40)}`,
      text: t.text,
      kind: `thought:${t.type}`,
      community: THOUGHTS_COMMUNITY,
      color: THOUGHT_COLOR,
      degree: 0,
      r: 3,
      hub: false,
      thought: t,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
    });
    index.set(id, i);
    for (const link of t.links ?? []) {
      const j = index.get(link);
      if (j !== undefined && j < memCount) addEdge(i, j, 'recall');
    }
    if (prevThought >= 0) addEdge(prevThought, i, 'next');
    prevThought = i;
  }
  const thoughtCount = nodes.length - memCount;
  if (thoughtCount > 0) {
    communities.push({ id: THOUGHTS_COMMUNITY, name: 'Live thoughts', color: THOUGHT_COLOR, size: thoughtCount });
  }

  const neighbors: number[][] = nodes.map(() => []);
  for (const e of edges) {
    neighbors[e.a].push(e.b);
    neighbors[e.b].push(e.a);
  }
  nodes.forEach((n, i) => {
    n.degree = neighbors[i].length;
    n.r = nodeRadiusForDegree(n.degree);
  });
  const ranked = nodes
    .map((n, i) => [n.degree, i] as const)
    .filter(([d, i]) => d >= 3 && i < memCount)
    .sort((x, y) => y[0] - x[0])
    .slice(0, 10);
  for (const [, i] of ranked) nodes[i].hub = true;

  seedPositions(nodes, neighbors, previous);
  return { nodes, edges, index, communities, neighbors };
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Keep old positions; place new nodes next to a placed neighbour. */
function seedPositions(nodes: GNode[], neighbors: number[][], previous?: GraphModel): void {
  const placed = new Array<boolean>(nodes.length).fill(false);
  nodes.forEach((n, i) => {
    const old = previous?.nodes[previous.index.get(n.id) ?? -1];
    if (old) {
      n.x = old.x;
      n.y = old.y;
      placed[i] = true;
    }
  });
  nodes.forEach((n, i) => {
    if (placed[i]) return;
    const anchor = neighbors[i].find((j) => placed[j]);
    const angle = i * GOLDEN_ANGLE;
    if (anchor !== undefined) {
      n.x = nodes[anchor].x + Math.cos(angle) * 24;
      n.y = nodes[anchor].y + Math.sin(angle) * 24;
    } else {
      const radius = 18 * Math.sqrt(i + 0.5);
      n.x = Math.cos(angle) * radius;
      n.y = Math.sin(angle) * radius;
    }
    placed[i] = true;
  });
}

/**
 * One step of the force layout (world space, unbounded). Linked nodes pull
 * together, everything repels, and members drift toward their community's
 * centre so clusters read as coloured islands. Returns kinetic energy.
 */
export function stepLayout(m: GraphModel, alpha = 1): number {
  const { nodes, edges } = m;
  const n = nodes.length;
  const repulse = 420 * alpha;
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        dx = (i - j) * 0.1 || 0.1;
        dy = 0.1;
        d2 = dx * dx + dy * dy;
      }
      if (d2 > 90000) continue;
      const f = repulse / d2;
      const d = Math.sqrt(d2);
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }
  }
  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const k = 0.03 * alpha * (d - 26);
    a.vx += (dx / d) * k;
    a.vy += (dy / d) * k;
    b.vx -= (dx / d) * k;
    b.vy -= (dy / d) * k;
  }
  const centres = new Map<string, { x: number; y: number; c: number }>();
  for (const p of nodes) {
    const c = centres.get(p.community) ?? { x: 0, y: 0, c: 0 };
    c.x += p.x;
    c.y += p.y;
    c.c += 1;
    centres.set(p.community, c);
  }
  let energy = 0;
  for (const p of nodes) {
    const c = centres.get(p.community)!;
    p.vx += (c.x / c.c - p.x) * 0.006 * alpha - p.x * 0.004 * alpha;
    p.vy += (c.y / c.c - p.y) * 0.006 * alpha - p.y * 0.004 * alpha;
    p.vx *= 0.8;
    p.vy *= 0.8;
    if (p.fixed) {
      p.vx = 0;
      p.vy = 0;
      continue;
    }
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > 10) {
      p.vx = (p.vx / speed) * 10;
      p.vy = (p.vy / speed) * 10;
    }
    p.x += p.vx;
    p.y += p.vy;
    energy += p.vx * p.vx + p.vy * p.vy;
  }
  return energy;
}

export function settleLayout(m: GraphModel, steps = 250): void {
  for (let s = 0; s < steps; s++) {
    const e = stepLayout(m, Math.max(0.1, 1 - s / steps));
    if (e < 0.005 * Math.max(1, m.nodes.length)) break;
  }
}

// ── Camera ───────────────────────────────────────────────────────────────

export interface Camera {
  x: number; // world point at the screen centre
  y: number;
  k: number; // zoom
}

export function toScreen(cam: Camera, w: number, h: number, x: number, y: number) {
  return { x: (x - cam.x) * cam.k + w / 2, y: (y - cam.y) * cam.k + h / 2 };
}

export function toWorld(cam: Camera, w: number, h: number, sx: number, sy: number) {
  return { x: (sx - w / 2) / cam.k + cam.x, y: (sy - h / 2) / cam.k + cam.y };
}

/** Camera that shows every visible node with a margin. */
export function fitCamera(nodes: GNode[], w: number, h: number, visible?: (n: GNode) => boolean): Camera {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (visible && !visible(n)) continue;
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, k: 1 };
  const spanX = Math.max(maxX - minX, 60);
  const spanY = Math.max(maxY - minY, 60);
  const k = Math.min(4, Math.max(0.1, Math.min((w * 0.86) / spanX, (h * 0.86) / spanY)));
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, k };
}

/** Zoom by `factor` keeping the world point under (sx, sy) fixed. */
export function zoomAt(cam: Camera, w: number, h: number, sx: number, sy: number, factor: number): Camera {
  const k = Math.min(8, Math.max(0.05, cam.k * factor));
  const before = toWorld(cam, w, h, sx, sy);
  const next = { ...cam, k };
  const after = toWorld(next, w, h, sx, sy);
  return { x: next.x + (before.x - after.x), y: next.y + (before.y - after.y), k };
}

/** Nearest visible node under a screen point, if any. */
export function pickNode(
  m: GraphModel,
  cam: Camera,
  w: number,
  h: number,
  sx: number,
  sy: number,
  visible: (n: GNode) => boolean,
): number {
  let best = -1;
  let bestD = Infinity;
  m.nodes.forEach((n, i) => {
    if (!visible(n)) return;
    const p = toScreen(cam, w, h, n.x, n.y);
    const d = Math.hypot(p.x - sx, p.y - sy);
    const reach = Math.max(6, n.r * cam.k + 3);
    if (d <= reach && d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/** Nodes whose label or text matches the query (case-insensitive). */
export function searchNodes(m: GraphModel, query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  m.nodes.forEach((n, i) => {
    if (n.label.toLowerCase().includes(q) || n.text.toLowerCase().includes(q)) out.push(i);
  });
  return out;
}
