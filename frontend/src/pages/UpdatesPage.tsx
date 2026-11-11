import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileWarning,
  GitMerge,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import {
  fetchForkUpdates,
  formatRelativeTime,
  groupCommits,
  hasPrivacyWarning,
  stepsToScript,
  verdictMeta,
  type ForkUpdateReport,
  type UpstreamCommit,
  type Verdict,
} from '../lib/forkUpdates';

const card: React.CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
};

function VerdictBadge({ verdict, large = false }: { verdict: Verdict | null | undefined; large?: boolean }) {
  const m = verdictMeta(verdict);
  return (
    <span
      className={`inline-flex items-center shrink-0 rounded-full font-semibold ${large ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-[11px]'}`}
      style={{ color: m.color, background: m.background, border: `1px solid ${m.color}` }}
    >
      {m.label}
    </span>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {}
      }}
      className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer shrink-0"
      style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
      title="Copy to clipboard"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? 'Copied' : label}
    </button>
  );
}

function FileList({ files, highlight }: { files: string[]; highlight?: Set<string> }) {
  return (
    <ul className="text-xs font-mono flex flex-col gap-0.5">
      {files.map((f) => (
        <li
          key={f}
          className="break-all"
          style={{ color: highlight?.has(f) ? 'var(--color-error)' : 'var(--color-text-secondary)' }}
        >
          {highlight?.has(f) ? '! ' : ''}
          {f}
        </li>
      ))}
    </ul>
  );
}

function CommitRow({ commit, conflictSet }: { commit: UpstreamCommit; conflictSet: Set<string> }) {
  const [open, setOpen] = useState(false);
  const privacy = hasPrivacyWarning(commit);
  return (
    <li style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 px-4 py-2.5 text-left cursor-pointer"
        aria-expanded={open}
      >
        <span className="mt-0.5" style={{ color: 'var(--color-text-tertiary)' }}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <VerdictBadge verdict={commit.verdict} />
            {privacy && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: 'var(--color-error)' }}>
                <ShieldAlert size={12} /> privacy
              </span>
            )}
            <span className="text-sm break-words" style={{ color: 'var(--color-text)' }}>
              {commit.subject}
            </span>
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-tertiary)' }}>
            <span className="font-mono">{commit.short_sha}</span> · {commit.author} · {commit.date.slice(0, 10)}
          </div>
        </div>
      </button>
      {open && (
        <div className="px-10 pb-3 flex flex-col gap-2">
          <ul className="flex flex-col gap-1">
            {commit.reasons.map((r, i) => {
              const level = commit.flags[i]?.level;
              return (
                <li
                  key={i}
                  className="text-xs flex gap-1.5"
                  style={{
                    color:
                      level === 'danger'
                        ? 'var(--color-error)'
                        : level === 'warning'
                          ? 'var(--color-warning)'
                          : 'var(--color-text-secondary)',
                  }}
                >
                  <span>•</span>
                  <span>{r}</span>
                </li>
              );
            })}
          </ul>
          {commit.body && (
            <p className="text-xs whitespace-pre-wrap" style={{ color: 'var(--color-text-secondary)' }}>
              {commit.body}
            </p>
          )}
          {commit.files.length > 0 && (
            <details>
              <summary className="text-[11px] cursor-pointer" style={{ color: 'var(--color-text-tertiary)' }}>
                {commit.files.length} file{commit.files.length === 1 ? '' : 's'} changed
              </summary>
              <div className="mt-1">
                <FileList files={commit.files} highlight={conflictSet} />
              </div>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

export function UpdatesPage() {
  const [report, setReport] = useState<ForkUpdateReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      setReport(await fetchForkUpdates(refresh));
    } catch (e: any) {
      setError(e?.message || 'Could not reach the Jarvis server.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Opening the tab is an explicit request to check upstream.
  useEffect(() => {
    load(true);
  }, [load]);

  // Keep the "x minutes ago" label fresh.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const groups = useMemo(() => groupCommits(report?.commits ?? []), [report]);
  const conflictSet = useMemo(() => new Set(report?.conflict_files ?? []), [report]);
  const privacyCount = useMemo(() => (report?.commits ?? []).filter(hasPrivacyWarning).length, [report]);
  const meta = verdictMeta(report?.verdict);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-10">
      <div className="max-w-4xl mx-auto w-full flex flex-col gap-5">
        <header>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
              Updates
            </h1>
            <div className="flex items-center gap-3">
              <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                Last checked {formatRelativeTime(report?.fetched_at ?? null)}
              </span>
              <button
                onClick={() => load(true)}
                disabled={loading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-60"
                style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)', border: '1px solid var(--color-accent)' }}
              >
                {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                {loading ? 'Checking…' : 'Check now'}
              </button>
            </div>
          </div>
          <p className="text-sm mt-2 max-w-2xl" style={{ color: 'var(--color-text-secondary)' }}>
            Your fork never updates itself. This page compares it with the official OpenJarvis code,
            explains what changed, and warns about anything that could break your customizations.
            Nothing is merged until you do it yourself.
          </p>
        </header>

        {error && (
          <div className="rounded-xl p-4 text-sm" style={{ ...card, color: 'var(--color-error)' }}>
            {error}
          </div>
        )}

        {!report && loading && (
          <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            <Loader2 size={14} className="animate-spin" /> Checking upstream…
          </div>
        )}

        {report && report.status !== 'ok' && (
          <div className="rounded-xl p-5 text-sm" style={{ ...card, color: 'var(--color-text)' }}>
            {report.message}
          </div>
        )}

        {report && report.status === 'ok' && (
          <>
            {/* Verdict summary */}
            <section className="rounded-xl p-5 flex flex-col gap-3" style={{ ...card, borderColor: meta.color }}>
              <div className="flex items-center gap-3 flex-wrap">
                <VerdictBadge verdict={report.verdict} large />
                <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                  {report.pending === 0
                    ? 'Up to date'
                    : `${report.pending} upstream commit${report.pending === 1 ? '' : 's'} waiting`}
                </span>
              </div>
              <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                {report.summary}
              </p>
              {report.pending > 0 && report.counts && (
                <div className="flex gap-2 flex-wrap text-xs">
                  {(['safe', 'review', 'will conflict'] as Verdict[]).map((v) => (
                    <span
                      key={v}
                      className="px-2 py-0.5 rounded-md"
                      style={{ background: verdictMeta(v).background, color: verdictMeta(v).color }}
                    >
                      {report.counts![v]} {verdictMeta(v).label.toLowerCase()}
                    </span>
                  ))}
                </div>
              )}
              <div className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                Your branch <span className="font-mono">{report.branch || 'HEAD'}</span>
                {typeof report.fork_ahead === 'number' && ` (${report.fork_ahead} commit${report.fork_ahead === 1 ? '' : 's'} of your own)`}
                {' '}vs <span className="font-mono">{report.upstream_ref}</span>
                {report.upstream_date && ` (latest upstream change ${report.upstream_date.slice(0, 10)})`}
              </div>
              {report.fetch_error && (
                <div className="text-xs" style={{ color: 'var(--color-warning)' }}>
                  Couldn't reach GitHub: {report.fetch_error}. Showing the last downloaded copy.
                </div>
              )}
            </section>

            {privacyCount > 0 && (
              <section
                className="rounded-xl p-4 flex gap-3 items-start"
                style={{ ...card, borderColor: 'var(--color-error)', background: 'color-mix(in srgb, var(--color-error) 8%, var(--color-surface))' }}
              >
                <ShieldAlert size={18} style={{ color: 'var(--color-error)' }} className="shrink-0 mt-0.5" />
                <div className="text-sm" style={{ color: 'var(--color-text)' }}>
                  <strong>{privacyCount} update{privacyCount === 1 ? '' : 's'} touch analytics or add internet access.</strong>{' '}
                  Look for the <span style={{ color: 'var(--color-error)' }}>privacy</span> tag below and read
                  those carefully — they could send information off your Mac.
                </div>
              </section>
            )}

            {(report.conflict_files?.length ?? 0) > 0 && (
              <section className="rounded-xl p-5" style={card}>
                <h3 className="text-sm font-semibold mb-1 flex items-center gap-2" style={{ color: 'var(--color-error)' }}>
                  <FileWarning size={14} /> Files that will conflict
                </h3>
                <p className="text-xs mb-3" style={{ color: 'var(--color-text-secondary)' }}>
                  Both you and upstream changed the same lines here. Git will stop and ask you to choose.
                </p>
                <FileList files={report.conflict_files!} highlight={conflictSet} />
              </section>
            )}

            {(report.overlap_files?.length ?? 0) > 0 && (
              <section className="rounded-xl p-5" style={card}>
                <h3 className="text-sm font-semibold mb-1 flex items-center gap-2" style={{ color: 'var(--color-warning)' }}>
                  <AlertTriangle size={14} /> Touches files you customized
                </h3>
                <p className="text-xs mb-3" style={{ color: 'var(--color-text-secondary)' }}>
                  Upstream also changed these files from your fork. Ones not marked “!” should merge cleanly — still worth a test.
                </p>
                <FileList files={report.overlap_files!} highlight={conflictSet} />
              </section>
            )}

            {groups.map((g) => (
              <section key={g.group} className="rounded-xl overflow-hidden" style={card}>
                <h3 className="text-sm font-semibold px-4 py-3" style={{ color: 'var(--color-text)' }}>
                  {g.title} <span style={{ color: 'var(--color-text-tertiary)' }}>({g.commits.length})</span>
                </h3>
                <ul>
                  {g.commits.map((c) => (
                    <CommitRow key={c.sha} commit={c} conflictSet={conflictSet} />
                  ))}
                </ul>
              </section>
            ))}

            {report.truncated && (
              <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                Only the newest {report.commits.length} commits are listed.
              </p>
            )}

            {(report.apply_steps?.length ?? 0) > 0 && (
              <section className="rounded-xl p-5" style={card}>
                <div className="flex items-center justify-between gap-3 mb-1">
                  <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--color-text)' }}>
                    <GitMerge size={14} /> How to apply it yourself
                  </h3>
                  <CopyButton text={stepsToScript(report.apply_steps!)} label="Copy all" />
                </div>
                <p className="text-xs mb-3" style={{ color: 'var(--color-text-secondary)' }}>
                  Run these in Terminal one at a time. The merge happens on a test branch first, so your
                  working setup stays untouched until the tests pass.
                </p>
                <ol className="flex flex-col gap-2">
                  {report.apply_steps!.map((s, i) => (
                    <li key={i} className="flex flex-col gap-1">
                      <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                        {i + 1}. {s.title}
                      </span>
                      <div className="flex items-center gap-2">
                        <code
                          className="flex-1 min-w-0 text-xs font-mono px-2.5 py-1.5 rounded-md overflow-x-auto whitespace-nowrap"
                          style={{ background: 'var(--color-code-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border-subtle)' }}
                        >
                          {s.command}
                        </code>
                        <CopyButton text={s.command} />
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
