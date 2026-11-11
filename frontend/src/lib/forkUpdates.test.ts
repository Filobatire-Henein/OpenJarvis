import { describe, expect, it } from 'vitest';
import {
  formatRelativeTime,
  groupCommits,
  hasPrivacyWarning,
  stepsToScript,
  verdictMeta,
  type UpstreamCommit,
} from './forkUpdates';

function commit(partial: Partial<UpstreamCommit>): UpstreamCommit {
  return {
    sha: partial.sha ?? 'abc',
    short_sha: (partial.sha ?? 'abc').slice(0, 8),
    author: 'A',
    date: '2026-11-01T00:00:00Z',
    subject: 's',
    body: '',
    group: 'other',
    files: [],
    verdict: 'safe',
    reasons: [],
    flags: [],
    conflict_files: [],
    ...partial,
  };
}

describe('forkUpdates helpers', () => {
  it('groups commits in display order and drops empty groups', () => {
    const groups = groupCommits([
      commit({ sha: '1', group: 'fixes' }),
      commit({ sha: '2', group: 'security' }),
      commit({ sha: '3', group: 'weird' }),
      commit({ sha: '4', group: 'fixes' }),
    ]);
    expect(groups.map((g) => g.group)).toEqual(['security', 'fixes', 'other']);
    expect(groups[1].commits.map((c) => c.sha)).toEqual(['1', '4']);
    expect(groups[0].title).toBe('Security');
  });

  it('maps verdicts to labels and colors', () => {
    expect(verdictMeta('will conflict').label).toBe('Will conflict');
    expect(verdictMeta('will conflict').color).toBe('var(--color-error)');
    expect(verdictMeta('review').color).toBe('var(--color-warning)');
    expect(verdictMeta('safe').color).toBe('var(--color-success)');
    expect(verdictMeta(null).label).toBe('Unknown');
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    expect(formatRelativeTime(null, now)).toBe('never');
    expect(formatRelativeTime('garbage', now)).toBe('never');
    expect(formatRelativeTime('2026-11-10T11:59:50Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-11-10T11:55:00Z', now)).toBe('5 minutes ago');
    expect(formatRelativeTime('2026-11-10T11:00:00Z', now)).toBe('1 hour ago');
    expect(formatRelativeTime('2026-11-08T12:00:00Z', now)).toBe('2 days ago');
  });

  it('builds a commented copy-paste script from apply steps', () => {
    expect(
      stepsToScript([
        { title: 'Fetch', command: 'git fetch upstream' },
        { title: 'Merge', command: 'git merge --no-ff upstream/main' },
      ]),
    ).toBe('# Fetch\ngit fetch upstream\n\n# Merge\ngit merge --no-ff upstream/main');
  });

  it('detects privacy/network warnings', () => {
    expect(hasPrivacyWarning(commit({}))).toBe(false);
    expect(
      hasPrivacyWarning(commit({ flags: [{ kind: 'network', level: 'danger', message: 'x' }] })),
    ).toBe(true);
    expect(
      hasPrivacyWarning(commit({ flags: [{ kind: 'dependencies', level: 'warning', message: 'x' }] })),
    ).toBe(false);
  });
});
