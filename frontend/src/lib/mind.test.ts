import { describe, expect, it } from 'vitest';
import {
  BUBBLE_LIFETIME_MS,
  MAX_BUBBLES,
  bubbleScale,
  createSimulation,
  decayPulses,
  hitTest,
  nodeRadius,
  parseSSE,
  pulseLinked,
  settle,
  spawnBubble,
  stepBubbles,
  tick,
  withAlpha,
  type MindGraph,
  type Thought,
} from './mind';

const graph: MindGraph = {
  nodes: [
    { id: 'a', label: 'A', kind: 'fact', weight: 1, created_at: 0 },
    { id: 'b', label: 'B', kind: 'doc', weight: 0.5, created_at: 0 },
    { id: 'c', label: 'C', kind: 'entity', weight: 0.1, created_at: 0 },
  ],
  edges: [
    { source: 'a', target: 'b', kind: 'similar' },
    { source: 'b', target: 'missing', kind: 'similar' },
  ],
};

const thought = (id: string, links: string[] = []): Thought => ({
  id,
  type: 'thought',
  text: `thought ${id}`,
  links,
  ts: 0,
});

describe('parseSSE', () => {
  it('extracts complete data frames and keeps the remainder', () => {
    const { payloads, rest } = parseSSE(
      'retry: 3000\n\nevent: thought\ndata: {"id":"t1"}\n\n: keep-alive\n\ndata: {"id"',
    );
    expect(payloads).toEqual(['{"id":"t1"}']);
    expect(rest).toBe('data: {"id"');
  });
});

describe('layout', () => {
  it('sizes nodes by weight within bounds', () => {
    expect(nodeRadius(0)).toBe(4);
    expect(nodeRadius(1)).toBe(16);
    expect(nodeRadius(Number.NaN)).toBe(4);
    expect(nodeRadius(5)).toBe(16);
  });

  it('builds a deterministic simulation and drops dangling edges', () => {
    const s1 = createSimulation(graph, 400, 300);
    const s2 = createSimulation(graph, 400, 300);
    expect(s1.nodes.map((n) => [n.x, n.y])).toEqual(s2.nodes.map((n) => [n.x, n.y]));
    expect(s1.links).toEqual([[0, 1]]);
  });

  it('keeps positions of existing nodes when the graph refreshes', () => {
    const sim = createSimulation(graph, 400, 300);
    sim.nodes[0].x = 42;
    sim.nodes[0].y = 24;
    const next = createSimulation(
      { ...graph, nodes: [...graph.nodes, { id: 'd', label: 'D', kind: 'note', weight: 0.3, created_at: 0 }] },
      400,
      300,
      sim,
    );
    expect(next.nodes[0].x).toBe(42);
    expect(next.nodes[0].y).toBe(24);
    expect(next.nodes).toHaveLength(4);
  });

  it('settles inside the canvas and loses energy', () => {
    const sim = createSimulation(graph, 400, 300);
    const first = tick(sim, 400, 300, 1);
    settle(sim, 400, 300);
    const later = tick(sim, 400, 300, 0.1);
    expect(later).toBeLessThan(first + 1e-9);
    for (const n of sim.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(n.r);
      expect(n.x).toBeLessThanOrEqual(400 - n.r);
      expect(n.y).toBeGreaterThanOrEqual(n.r);
      expect(n.y).toBeLessThanOrEqual(300 - n.r);
    }
    // Linked nodes end up closer together than the unlinked one.
    const [a, b, c] = sim.nodes;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(Math.hypot(a.x - c.x, a.y - c.y) + 60);
  });
});

describe('bubbles', () => {
  it('spawns near the centre and caps the count', () => {
    let bubbles = spawnBubble([], thought('t0'), 400, 300, 0, 1);
    expect(Math.hypot(bubbles[0].x - 200, bubbles[0].y - 150)).toBeLessThan(80);
    for (let i = 1; i < 30; i++) bubbles = spawnBubble(bubbles, thought(`t${i}`), 400, 300, i, i);
    expect(bubbles).toHaveLength(MAX_BUBBLES);
    expect(bubbles[bubbles.length - 1].id).toBe('t29');
  });

  it('pops in, then fades and expires', () => {
    const [b] = spawnBubble([], thought('t'), 400, 300, 1000, 1);
    expect(bubbleScale(b, 1000)).toBeCloseTo(0, 5);
    expect(bubbleScale(b, 1000 + 2000)).toBeCloseTo(1, 5);
    expect(bubbleScale(b, 1000, true)).toBe(1); // reduced motion: no pop
    expect(bubbleScale(b, 1000 + BUBBLE_LIFETIME_MS - 1)).toBeLessThan(0.01);
    expect(stepBubbles([b], 1000 + BUBBLE_LIFETIME_MS + 1, 400, 300)).toEqual([]);
  });

  it('pulses linked memories and decays them', () => {
    const sim = createSimulation(graph, 400, 300);
    expect(pulseLinked(sim, ['a', 'nope'])).toBe(1);
    expect(sim.nodes[0].pulse).toBe(1);
    decayPulses(sim, 5000);
    expect(sim.nodes[0].pulse).toBeLessThan(0.1);
  });

  it('hit-tests bubbles before nodes', () => {
    const sim = createSimulation(graph, 400, 300);
    const n = sim.nodes[0];
    expect(hitTest(sim, [], n.x, n.y)).toEqual({ kind: 'node', node: n });
    const [b] = spawnBubble([], thought('t'), 400, 300, 0, 1);
    b.x = n.x;
    b.y = n.y;
    expect(hitTest(sim, [b], n.x, n.y)?.kind).toBe('bubble');
    expect(hitTest(sim, [], -100, -100)).toBeNull();
  });
});

describe('withAlpha', () => {
  it('handles hex and rgb colours', () => {
    expect(withAlpha('#22d3ee', 0.5)).toBe('rgba(34, 211, 238, 0.5)');
    expect(withAlpha('#fff', 1)).toBe('rgba(255, 255, 255, 1)');
    expect(withAlpha('rgba(8, 145, 178, 0.08)', 0.3)).toBe('rgba(8, 145, 178, 0.3)');
    expect(withAlpha('  ', 0.2)).toBe('rgba(128, 128, 128, 0.2)');
  });
});
