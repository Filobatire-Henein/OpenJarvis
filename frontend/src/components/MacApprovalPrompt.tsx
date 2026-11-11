import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Monitor, OctagonX, X } from 'lucide-react';
import {
  approveAction,
  denyAction,
  fetchMacControlStatus,
  fetchPendingApprovals,
  stopMacControl,
} from '../lib/api';
import type { PendingApproval } from '../lib/api';

/** Approvals created by risky mac_* tools (they block until answered). */
export function isMacApproval(a: PendingApproval): boolean {
  return a.action_type.startsWith('mac_');
}

export function secondsLeft(expiresAt: string, now: number): number {
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.ceil((t - now) / 1000));
}

function untrustedSources(a: PendingApproval): string[] {
  const raw = (a.payload as { untrusted_sources?: unknown })?.untrusted_sources;
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : [];
}

/** Description without the backend's appended warning (shown separately). */
function mainText(description: string): string {
  const i = description.indexOf(' ⚠ ');
  return i >= 0 ? description.slice(0, i) : description;
}

export function MacApprovalCard({
  approval,
  now,
  busy,
  onApprove,
  onDeny,
  onStop,
}: {
  approval: PendingApproval;
  now: number;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
  onStop: () => void;
}) {
  const left = secondsLeft(approval.expires_at, now);
  const sources = untrustedSources(approval);
  return (
    <div
      role="alertdialog"
      aria-label="Jarvis is asking for permission"
      className="rounded-xl shadow-2xl p-4 flex flex-col gap-3"
      style={{
        width: 'min(380px, calc(100vw - 32px))',
        background: 'var(--color-bg-secondary)',
        border: '2px solid var(--color-warning)',
      }}
    >
      <div className="flex items-center gap-2">
        <Monitor size={16} style={{ color: 'var(--color-warning)' }} />
        <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          Allow this action on your Mac?
        </span>
        <span className="ml-auto text-xs tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>
          {left}s
        </span>
      </div>
      <p className="text-sm break-words" style={{ color: 'var(--color-text)' }}>
        {mainText(approval.description)}
      </p>
      {sources.length > 0 && (
        <div
          className="flex gap-2 text-xs rounded-lg p-2"
          style={{
            background: 'color-mix(in srgb, var(--color-error) 10%, transparent)',
            color: 'var(--color-error)',
          }}
        >
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>
            Jarvis recently read outside content ({sources.join(', ')}). This request may come from
            that content, not from you. Only approve if you asked for it.
          </span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={onApprove}
          disabled={busy}
          className="flex-1 flex items-center justify-center gap-1.5 text-sm font-medium py-2 rounded-lg cursor-pointer disabled:opacity-50"
          style={{ background: 'var(--color-success, #16a34a)', color: '#fff' }}
        >
          <Check size={14} /> Approve
        </button>
        <button
          onClick={onDeny}
          disabled={busy}
          className="flex-1 flex items-center justify-center gap-1.5 text-sm font-medium py-2 rounded-lg cursor-pointer disabled:opacity-50"
          style={{ background: 'var(--color-error)', color: '#fff' }}
        >
          <X size={14} /> Deny
        </button>
      </div>
      <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        <span>No answer = denied.</span>
        <button
          onClick={onStop}
          disabled={busy}
          className="flex items-center gap-1 cursor-pointer underline disabled:opacity-50"
          style={{ color: 'var(--color-error)' }}
        >
          <OctagonX size={11} /> Stop all computer control
        </button>
      </div>
    </div>
  );
}

/**
 * Prominent Approve/Deny prompt for risky computer-control actions.
 * Reuses the shared approvals API; only polls quickly while the feature is on.
 */
export function MacApprovalPrompt() {
  const [enabled, setEnabled] = useState(false);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const check = () =>
      fetchMacControlStatus()
        .then((s) => mounted.current && setEnabled(s.enabled && !s.stopped))
        .catch(() => mounted.current && setEnabled(false));
    check();
    const id = setInterval(check, 30000);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const all = await fetchPendingApprovals();
      if (mounted.current) setApprovals(all.filter(isMacApproval));
    } catch {
      // backend not reachable
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setApprovals([]);
      return;
    }
    load();
    const id = setInterval(load, 1500);
    return () => clearInterval(id);
  }, [enabled, load]);

  useEffect(() => {
    if (approvals.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [approvals.length]);

  const current = approvals.find((a) => secondsLeft(a.expires_at, now) > 0);
  if (!current) return null;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // expired or already decided — refresh below
    } finally {
      setBusy(false);
      load();
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <MacApprovalCard
        approval={current}
        now={now}
        busy={busy}
        onApprove={() => act(() => approveAction(current.id))}
        onDeny={() => act(() => denyAction(current.id))}
        onStop={() =>
          act(async () => {
            await stopMacControl();
            setEnabled(false);
          })
        }
      />
    </div>
  );
}
