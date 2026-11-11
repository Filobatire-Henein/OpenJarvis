import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { MacControlStatus, PendingApproval } from '../lib/api';
import { ComputerControlPanel } from './ComputerControlSettings';
import { MacApprovalCard, isMacApproval, secondsLeft } from './MacApprovalPrompt';

const NOW = Date.parse('2026-11-11T10:00:00Z');

function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'abc123def456',
    action_type: 'mac_type_text',
    description: "Jarvis wants to type 'hello' into Safari.",
    payload: { untrusted_sources: [] },
    permission_key: 'mac_type_text:interactive',
    tier: 'high',
    status: 'pending',
    created_at: '2026-11-11T09:59:30Z',
    expires_at: '2026-11-11T10:00:30Z',
    ...overrides,
  };
}

describe('mac approval prompt', () => {
  it('only picks computer-control approvals', () => {
    expect(isMacApproval(approval())).toBe(true);
    expect(isMacApproval(approval({ action_type: 'email_delete' }))).toBe(false);
  });

  it('counts down to the expiry', () => {
    expect(secondsLeft('2026-11-11T10:00:30Z', NOW)).toBe(30);
    expect(secondsLeft('2026-11-11T09:00:00Z', NOW)).toBe(0);
    expect(secondsLeft('garbage', NOW)).toBe(0);
  });

  it('shows plain-English description with Approve and Deny', () => {
    const html = renderToStaticMarkup(
      <MacApprovalCard approval={approval()} now={NOW} busy={false} onApprove={vi.fn()} onDeny={vi.fn()} onStop={vi.fn()} />,
    );
    expect(html).toContain('Jarvis wants to type &#x27;hello&#x27; into Safari.');
    expect(html).toContain('Approve');
    expect(html).toContain('Deny');
    expect(html).toContain('30s');
    expect(html).toContain('No answer = denied.');
    expect(html).not.toContain('outside content');
  });

  it('warns when the request may come from content Jarvis read', () => {
    const a = approval({
      description: "Jarvis wants to type 'x' into Safari. ⚠ Jarvis recently read outside content (web_search).",
      payload: { untrusted_sources: ['web_search'] },
    });
    const html = renderToStaticMarkup(
      <MacApprovalCard approval={a} now={NOW} busy={false} onApprove={vi.fn()} onDeny={vi.fn()} onStop={vi.fn()} />,
    );
    expect(html).toContain('outside content (web_search)');
    expect(html).toContain('Only approve if you asked for it');
  });
});

const STATUS: MacControlStatus = {
  platform_supported: true,
  enabled: false,
  stopped: false,
  allow_safe_without_asking: true,
  approval_timeout_s: 60,
  max_risky_per_minute: 10,
  max_safe_per_minute: 30,
  vision_model: 'qwen3.5:9b',
  permissions: { accessibility: false, screen_recording: true },
  help: {},
  safe_actions: ['Open or switch to an app'],
  ask_first_actions: ['Type text'],
  tools: {},
};

describe('computer control settings panel', () => {
  it('explains how to enable when off and shows permissions', () => {
    const html = renderToStaticMarkup(
      <ComputerControlPanel status={STATUS} busy={false} onStop={vi.fn()} onResume={vi.fn()} onOpenPane={vi.fn()} />,
    );
    expect(html).toContain('Off');
    expect(html).toContain('[mac_control] enabled = true');
    expect(html).toContain('Accessibility');
    expect(html).toContain('Not allowed');
    expect(html).toContain('Open or switch to an app');
    expect(html).toContain('Type text');
    expect(html).not.toContain('>Stop<');
  });

  it('offers the kill switch when enabled, and resume when stopped', () => {
    const on = renderToStaticMarkup(
      <ComputerControlPanel status={{ ...STATUS, enabled: true }} busy={false} onStop={vi.fn()} onResume={vi.fn()} onOpenPane={vi.fn()} />,
    );
    expect(on).toContain('Stop');
    const stopped = renderToStaticMarkup(
      <ComputerControlPanel status={{ ...STATUS, enabled: true, stopped: true }} busy={false} onStop={vi.fn()} onResume={vi.fn()} onOpenPane={vi.fn()} />,
    );
    expect(stopped).toContain('Stopped');
    expect(stopped).toContain('Resume');
  });
});
