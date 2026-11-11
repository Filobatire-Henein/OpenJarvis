import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMindGraph, streamMind, type MindGraph, type Thought } from '../lib/mind';

const MAX_THOUGHTS = 40;

export type LiveState = 'connecting' | 'live' | 'offline';

/**
 * Memories + live thoughts for the knowledge graph. Talks only to the local
 * server. `flashes` maps a memory id to when a thought last recalled it, so
 * the graph can light it up; it is a ref because it changes every thought and
 * is read from the animation loop.
 */
export function useMindData() {
  const [graph, setGraph] = useState<MindGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [live, setLive] = useState<LiveState>('connecting');
  const flashes = useRef(new Map<string, number>());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
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
    void reload(ctrl.signal);
    return () => ctrl.abort();
  }, [reload]);

  useEffect(() => {
    const ctrl = new AbortController();
    let attempt = 0;
    const onThought = (t: Thought) => {
      setThoughts((prev) => [...prev.filter((p) => p.id !== t.id), t].slice(-MAX_THOUGHTS));
      if (t.replay) return;
      const now = performance.now();
      for (const id of t.links ?? []) flashes.current.set(id, now);
      flashes.current.set(`t:${t.id}`, now);
      if (t.event === 'memory_store') {
        // A new memory was saved: refetch shortly so it appears in the graph.
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => void reload(), 1500);
      }
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
          }
        } catch {
          if (ctrl.signal.aborted) return;
        }
        setLive('offline');
        attempt = Math.min(attempt + 1, 6);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
    })();
    return () => {
      ctrl.abort();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [reload]);

  return { graph, loading, error, thoughts, live, flashes, reload };
}
