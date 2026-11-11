// Mind page: data access. Everything here talks only to the local OpenJarvis
// server (getBase()). The graph layout and drawing live in lib/graph.ts.

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
