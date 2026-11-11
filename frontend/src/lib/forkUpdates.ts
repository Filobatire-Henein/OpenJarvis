import { useEffect, useState } from 'react';
import { apiFetch } from './api';

/**
 * This build is the Filo fork of OpenJarvis. The fork never replaces itself
 * with upstream code: the Tauri auto-updater is disabled and upstream changes
 * are reviewed on the Updates page (`/updates`) and merged by hand.
 */
export const FORK_BUILD = true;
export const FORK_UPDATES_PATH = '/updates';

export type Verdict = 'safe' | 'review' | 'will conflict';
export type FlagLevel = 'warning' | 'danger';

export interface UpdateFlag {
  kind: string;
  level: FlagLevel;
  message: string;
}

export interface UpstreamCommit {
  sha: string;
  short_sha: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  group: string;
  files: string[];
  verdict: Verdict;
  reasons: string[];
  flags: UpdateFlag[];
  conflict_files: string[];
}

export interface ApplyStep {
  title: string;
  command: string;
}

export interface ForkUpdateReport {
  status: 'ok' | 'not_git' | 'no_upstream' | 'error';
  message: string;
  checked_at?: string;
  fetched?: boolean;
  fetched_at?: string | null;
  fetch_error?: string | null;
  repo_root?: string;
  branch?: string;
  upstream_ref?: string;
  upstream_date?: string;
  is_fork?: boolean;
  pending: number;
  fork_ahead?: number;
  truncated?: boolean;
  verdict: Verdict | null;
  summary?: string;
  counts?: Record<Verdict, number>;
  groups?: Record<string, string[]>;
  commits: UpstreamCommit[];
  conflict_files?: string[];
  conflict_error?: string | null;
  overlap_files?: string[];
  apply_steps?: ApplyStep[];
}

export async function fetchForkUpdates(refresh: boolean): Promise<ForkUpdateReport> {
  const res = await apiFetch(`/v1/fork/updates${refresh ? '?refresh=1' : ''}`);
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  const report = (await res.json()) as ForkUpdateReport;
  publishPendingCount(report);
  return report;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export const GROUP_TITLES: Record<string, string> = {
  security: 'Security',
  features: 'New features',
  fixes: 'Fixes',
  docs: 'Docs',
  chore: 'Maintenance',
  other: 'Other',
};

export const GROUP_ORDER = ['security', 'features', 'fixes', 'docs', 'chore', 'other'];

export interface VerdictMeta {
  label: string;
  color: string;
  background: string;
  description: string;
}

export function verdictMeta(verdict: Verdict | null | undefined): VerdictMeta {
  switch (verdict) {
    case 'will conflict':
      return {
        label: 'Will conflict',
        color: 'var(--color-error)',
        background: 'color-mix(in srgb, var(--color-error) 12%, transparent)',
        description: 'Git cannot merge this on its own — it clashes with your changes.',
      };
    case 'review':
      return {
        label: 'Review',
        color: 'var(--color-warning)',
        background: 'color-mix(in srgb, var(--color-warning) 14%, transparent)',
        description: 'Probably merges, but touches something sensitive. Read the notes.',
      };
    case 'safe':
      return {
        label: 'Safe',
        color: 'var(--color-success)',
        background: 'color-mix(in srgb, var(--color-success) 12%, transparent)',
        description: "Doesn't touch your customizations.",
      };
    default:
      return {
        label: 'Unknown',
        color: 'var(--color-text-secondary)',
        background: 'var(--color-bg-secondary)',
        description: '',
      };
  }
}

/** Group commits in display order, dropping empty groups. */
export function groupCommits(commits: UpstreamCommit[]): { group: string; title: string; commits: UpstreamCommit[] }[] {
  const buckets = new Map<string, UpstreamCommit[]>();
  for (const c of commits) {
    const key = GROUP_ORDER.includes(c.group) ? c.group : 'other';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(c);
  }
  return GROUP_ORDER.filter((g) => buckets.has(g)).map((g) => ({
    group: g,
    title: GROUP_TITLES[g] ?? g,
    commits: buckets.get(g)!,
  }));
}

/** Flatten apply steps into a copy-pasteable shell snippet with comments. */
export function stepsToScript(steps: ApplyStep[]): string {
  return steps.map((s) => `# ${s.title}\n${s.command}`).join('\n\n');
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'never';
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** True when any flag on the commit is a privacy / network warning. */
export function hasPrivacyWarning(commit: UpstreamCommit): boolean {
  return commit.flags.some((f) => f.kind === 'privacy' || f.kind === 'network');
}

// ---------------------------------------------------------------------------
// Sidebar badge: pending upstream commit count (local git only, no network)
// ---------------------------------------------------------------------------

const PENDING_EVENT = 'oj-fork-pending';
let lastPending: number | null = null;

function publishPendingCount(report: ForkUpdateReport): void {
  lastPending = report.status === 'ok' ? report.pending : null;
  try {
    window.dispatchEvent(new CustomEvent(PENDING_EVENT, { detail: lastPending }));
  } catch {}
}

/**
 * Pending upstream commit count for the sidebar badge. Reads the last
 * downloaded upstream refs (refresh=0) — never contacts GitHub.
 */
export function useForkPendingCount(): number | null {
  const [count, setCount] = useState<number | null>(lastPending);
  useEffect(() => {
    const onUpdate = (e: Event) => setCount((e as CustomEvent<number | null>).detail);
    window.addEventListener(PENDING_EVENT, onUpdate);
    if (lastPending === null) {
      fetchForkUpdates(false).catch(() => {});
    }
    return () => window.removeEventListener(PENDING_EVENT, onUpdate);
  }, []);
  return count;
}
