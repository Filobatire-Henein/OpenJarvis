import { describe, expect, it } from 'vitest';
import {
  buildGraphModel,
  COMMUNITY_COLORS,
  detectCommunities,
  fitCamera,
  pickNode,
  searchNodes,
  settleLayout,
  THOUGHT_COLOR,
  toScreen,
  toWorld,
  zoomAt,
} from './graph';
import type { MindGraph, Thought } from './mind';

/** Two triangles joined by one bridge, plus one loner. */
function twoClusters(): MindGraph {
  const node = (id: string, label = id) => ({ id, label, kind: 'fact', weight: 0.5, created_at: 0 });
  const edge = (source: string, target: string) => ({ source, target, kind: 'similar' });
  return {
    nodes: ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'solo'].map((id) => node(id, id === 'a1' ? 'Coffee' : id)),
    edges: [
      edge('a1', 'a2'), edge('a1', 'a3'), edge('a2', 'a3'), edge('a1', 'a4'), edge('a3', 'a4'),
      edge('b1', 'b2'), edge('b2', 'b3'), edge('b1', 'b3'),
      edge('a4', 'b1'),
      edge('a1', 'ghost'), // dangling: dropped
    ],
  };
}

describe('communities', () => {
  it('finds dense clusters', () => {
    const ids = ['a', 'b', 'c', 'x', 'y', 'z'];
    const adj = [[1, 2], [0, 2], [0, 1, 3], [2, 4, 5], [3, 5], [3, 4]];
    const labels = detectCommunities(ids, adj);
    expect(labels[0]).toBe(labels[1]);
    expect(labels[4]).toBe(labels[5]);
    expect(labels[0]).not.toBe(labels[5]);
  });

  it('colours by community, names it after its hub, and keeps loners apart', () => {
    const m = buildGraphModel(twoClusters());
    const big = m.communities[0];
    expect(big.size).toBe(4);
    expect(big.name).toBe('Coffee'); // most connected member of the bigger cluster
    expect(big.color).toBe(COMMUNITY_COLORS[0]);
    const a1 = m.nodes[m.index.get('a1')!];
    const b1 = m.nodes[m.index.get('b1')!];
    expect(a1.community).not.toBe(b1.community);
    expect(m.nodes[m.index.get('solo')!].community).toBe('loose');
    expect(m.edges).toHaveLength(9);
  });

  it('makes well-connected nodes bigger', () => {
    const m = buildGraphModel(twoClusters());
    expect(m.nodes[m.index.get('a1')!].r).toBeGreaterThan(m.nodes[m.index.get('solo')!].r);
  });
});

describe('thoughts in the graph', () => {
  const t = (id: string, ts: number, links: string[]): Thought => ({ id, type: 'thought', text: `thinking ${id}`, links, ts });

  it('adds thoughts as their own nodes wired to recalled memories and to each other', () => {
    const m = buildGraphModel(twoClusters(), [t('2', 2, []), t('1', 1, ['a1', 'b2', 'ghost'])]);
    const first = m.index.get('t:1')!;
    const second = m.index.get('t:2')!;
    expect(m.nodes[first].color).toBe(THOUGHT_COLOR);
    const recalled = m.neighbors[first].map((j) => m.nodes[j].id).sort();
    expect(recalled).toEqual(['a1', 'b2', 't:2']);
    expect(m.edges.some((e) => e.kind === 'next' && e.a === first && e.b === second)).toBe(true);
    expect(m.communities[m.communities.length - 1]?.name).toBe('Live thoughts');
  });

  it('thoughts never merge memory communities', () => {
    const plain = buildGraphModel(twoClusters());
    const withThought = buildGraphModel(twoClusters(), [t('1', 1, ['a2', 'b3'])]);
    const ids = (m: typeof plain) => m.nodes.filter((n) => !n.thought).map((n) => n.community);
    expect(ids(withThought)).toEqual(ids(plain));
  });
});

describe('layout', () => {
  it('keeps positions when the graph refreshes', () => {
    const first = buildGraphModel(twoClusters());
    settleLayout(first, 60);
    const a1 = first.nodes[first.index.get('a1')!];
    const second = buildGraphModel(twoClusters(), [], first);
    const again = second.nodes[second.index.get('a1')!];
    expect([again.x, again.y]).toEqual([a1.x, a1.y]);
  });

  it('settles to finite positions with linked nodes closer than unlinked ones', () => {
    const m = buildGraphModel(twoClusters());
    settleLayout(m, 300);
    for (const n of m.nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
    const at = (id: string) => m.nodes[m.index.get(id)!];
    const d = (p: string, q: string) => Math.hypot(at(p).x - at(q).x, at(p).y - at(q).y);
    expect(d('b1', 'b2')).toBeLessThan(d('a2', 'b3'));
  });
});

describe('camera', () => {
  it('round-trips screen and world coordinates', () => {
    const cam = { x: 10, y: -5, k: 2 };
    const s = toScreen(cam, 800, 600, 30, 40);
    const w = toWorld(cam, 800, 600, s.x, s.y);
    expect(w.x).toBeCloseTo(30);
    expect(w.y).toBeCloseTo(40);
  });

  it('zooms around the cursor', () => {
    const cam = { x: 0, y: 0, k: 1 };
    const before = toWorld(cam, 800, 600, 100, 100);
    const next = zoomAt(cam, 800, 600, 100, 100, 2);
    const after = toWorld(next, 800, 600, 100, 100);
    expect(next.k).toBe(2);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('fits every node on screen and picks the node under the pointer', () => {
    const m = buildGraphModel(twoClusters());
    settleLayout(m, 100);
    const cam = fitCamera(m.nodes, 800, 600);
    for (const n of m.nodes) {
      const p = toScreen(cam, 800, 600, n.x, n.y);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(800);
    }
    const target = m.nodes[m.index.get('b2')!];
    const p = toScreen(cam, 800, 600, target.x, target.y);
    expect(pickNode(m, cam, 800, 600, p.x, p.y, () => true)).toBe(m.index.get('b2'));
    expect(pickNode(m, cam, 800, 600, p.x, p.y, (n) => n.id !== 'b2')).not.toBe(m.index.get('b2'));
  });
});

describe('search', () => {
  it('matches labels and text, ignoring case', () => {
    const m = buildGraphModel(twoClusters());
    expect(searchNodes(m, 'coffee')).toEqual([m.index.get('a1')]);
    expect(searchNodes(m, '  ')).toEqual([]);
  });
});
