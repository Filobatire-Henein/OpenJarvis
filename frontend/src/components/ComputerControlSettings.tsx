import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, HelpCircle, OctagonX, Play, XCircle } from 'lucide-react';
import {
  fetchMacControlStatus,
  openMacPrivacySettings,
  resumeMacControl,
  stopMacControl,
} from '../lib/api';
import type { MacControlStatus } from '../lib/api';

type Pane = 'accessibility' | 'screen_recording' | 'automation';

function PermissionRow({
  label,
  granted,
  why,
  onFix,
}: {
  label: string;
  granted: boolean | null;
  why: string;
  onFix: () => void;
}) {
  const Icon = granted === true ? CheckCircle : granted === false ? XCircle : HelpCircle;
  const color =
    granted === true
      ? 'var(--color-success, #16a34a)'
      : granted === false
        ? 'var(--color-error)'
        : 'var(--color-text-tertiary)';
  const state = granted === true ? 'Allowed' : granted === false ? 'Not allowed' : 'Unknown';
  return (
    <div className="flex items-start gap-2 py-2" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
      <Icon size={14} className="mt-0.5 shrink-0" style={{ color }} />
      <div className="min-w-0 flex-1">
        <div className="text-sm" style={{ color: 'var(--color-text)' }}>
          {label}: <span style={{ color }}>{state}</span>
        </div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-tertiary)' }}>{why}</div>
      </div>
      {granted !== true && (
        <button
          onClick={onFix}
          className="text-xs px-2 py-1 rounded-md cursor-pointer shrink-0"
          style={{ border: '1px solid var(--color-border)', color: 'var(--color-accent)' }}
        >
          Open System Settings
        </button>
      )}
    </div>
  );
}

export function ComputerControlPanel({
  status,
  busy,
  onStop,
  onResume,
  onOpenPane,
}: {
  status: MacControlStatus;
  busy: boolean;
  onStop: () => void;
  onResume: () => void;
  onOpenPane: (pane: Pane) => void;
}) {
  if (!status.platform_supported) {
    return (
      <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
        Computer control is only available on macOS.
      </p>
    );
  }
  const stateLabel = !status.enabled ? 'Off' : status.stopped ? 'Stopped' : 'On';
  const stateColor = !status.enabled
    ? 'var(--color-text-tertiary)'
    : status.stopped
      ? 'var(--color-error)'
      : 'var(--color-success, #16a34a)';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm" style={{ color: 'var(--color-text)' }}>
            Status: <span style={{ color: stateColor, fontWeight: 600 }}>{stateLabel}</span>
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-tertiary)' }}>
            {status.enabled
              ? `Risky actions wait for your approval (auto-deny after ${status.approval_timeout_s}s, max ${status.max_risky_per_minute}/min).`
              : 'Turn on by adding [mac_control] enabled = true to ~/.openjarvis/config.toml, then restart.'}
          </div>
        </div>
        {status.enabled &&
          (status.stopped ? (
            <button
              onClick={onResume}
              disabled={busy}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg cursor-pointer disabled:opacity-50 shrink-0"
              style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              <Play size={13} /> Resume
            </button>
          ) : (
            <button
              onClick={onStop}
              disabled={busy}
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg cursor-pointer disabled:opacity-50 shrink-0"
              style={{ background: 'var(--color-error)', color: '#fff' }}
            >
              <OctagonX size={13} /> Stop
            </button>
          ))}
      </div>

      <div>
        <PermissionRow
          label="Accessibility"
          granted={status.permissions.accessibility}
          why="Needed to type, press keys, click and scroll."
          onFix={() => onOpenPane('accessibility')}
        />
        <PermissionRow
          label="Screen Recording"
          granted={status.permissions.screen_recording}
          why="Needed to look at the screen. Screenshots go only to your local model and are deleted at once."
          onFix={() => onOpenPane('screen_recording')}
        />
        <PermissionRow
          label="Automation (System Events)"
          granted={null}
          why="macOS asks the first time Jarvis reads the frontmost app or open apps."
          onFix={() => onOpenPane('automation')}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="text-xs font-semibold mb-1" style={{ color: 'var(--color-text)' }}>
            {status.allow_safe_without_asking ? 'Runs without asking' : 'Asks first (safe actions too)'}
          </div>
          <ul className="text-xs list-disc pl-4 space-y-0.5" style={{ color: 'var(--color-text-secondary)' }}>
            {status.safe_actions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
        <div>
          <div className="text-xs font-semibold mb-1" style={{ color: 'var(--color-text)' }}>
            Always asks first
          </div>
          <ul className="text-xs list-disc pl-4 space-y-0.5" style={{ color: 'var(--color-text-secondary)' }}>
            {status.ask_first_actions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      </div>
      {status.vision_model && (
        <div className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
          Screen reading model: {status.vision_model} (local)
        </div>
      )}
    </div>
  );
}

/** Settings → "Computer control" section (self-contained, additive). */
export function ComputerControlSettings() {
  const [status, setStatus] = useState<MacControlStatus | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await fetchMacControlStatus());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // ignore; status refresh below shows the truth
    } finally {
      setBusy(false);
      load();
    }
  };

  return (
    <div
      className="rounded-xl p-5"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
    >
      <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--color-text)' }}>
        Computer control
      </h3>
      {status ? (
        <ComputerControlPanel
          status={status}
          busy={busy}
          onStop={() => run(stopMacControl)}
          onResume={() => run(resumeMacControl)}
          onOpenPane={(pane) => run(() => openMacPrivacySettings(pane))}
        />
      ) : (
        <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          {error ? 'Could not read computer-control status from the backend.' : 'Loading…'}
        </p>
      )}
    </div>
  );
}
