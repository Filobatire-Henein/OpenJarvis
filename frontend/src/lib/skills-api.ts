import { apiFetch } from './api';

// ---------------------------------------------------------------------------
// Skills advisor API (/v1/skills/*). Every call goes through apiFetch so the
// Bearer header is attached when the local server requires a key.
// ---------------------------------------------------------------------------

export type SkillRating = 'recommended' | 'useful' | 'caution' | 'unsafe';

export interface SkillFinding {
  rule: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  message: string;
  file: string;
  evidence: string;
}

export interface SkillReview {
  name: string;
  source: string;
  category: string;
  description: string;
  rating: SkillRating;
  score: number;
  reasons: string[];
  capabilities: string[];
  usefulness: string;
  findings: SkillFinding[];
  needed_tools: string[];
  missing_tools: string[];
  has_scripts: boolean;
  script_files: string[];
  install_command: string;
  summary: string;
  blocked: boolean;
  needs_confirmation: boolean;
  installed?: boolean;
  path?: string;
  installed_at?: string;
}

export interface CatalogResponse {
  skills: SkillReview[];
  errors: { source: string; error: string }[];
  sources: string[];
}

export interface InstallResponse {
  status: 'installed' | 'already_installed' | 'needs_confirmation' | 'blocked' | 'failed';
  message: string;
  review: SkillReview;
  target_path: string;
  warnings: string[];
}

async function errorDetail(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body && (body.detail || body.message)) || `${res.status} ${res.statusText}`;
}

export async function fetchSkillCatalog(
  opts: { source?: string; q?: string; refresh?: boolean } = {},
): Promise<CatalogResponse> {
  const params = new URLSearchParams();
  if (opts.source) params.set('source', opts.source);
  if (opts.q) params.set('q', opts.q);
  if (opts.refresh) params.set('refresh', 'true');
  const qs = params.toString();
  const res = await apiFetch(`/v1/skills/catalog${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(await errorDetail(res));
  return res.json();
}

export async function fetchInstalledSkills(): Promise<SkillReview[]> {
  const res = await apiFetch('/v1/skills/installed');
  if (!res.ok) throw new Error(await errorDetail(res));
  const data = await res.json();
  return data.skills || [];
}

export async function reviewSkill(body: {
  source: string;
  name: string;
  category?: string;
  explain?: boolean;
}): Promise<SkillReview> {
  const res = await apiFetch('/v1/skills/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorDetail(res));
  return res.json();
}

export async function installSkill(body: {
  source: string;
  name: string;
  category?: string;
  confirm: boolean;
  override_unsafe?: boolean;
}): Promise<InstallResponse> {
  const res = await apiFetch('/v1/skills/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (data && typeof data === 'object' && 'status' in data && 'review' in data) {
    return data as InstallResponse;
  }
  throw new Error((data && data.detail) || `Install failed: ${res.status}`);
}

export async function removeSkill(name: string): Promise<void> {
  const res = await apiFetch(`/v1/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await errorDetail(res));
}

export const CAPABILITY_LABELS: Record<string, string> = {
  'shell:execute': 'Run shell commands / programs',
  'filesystem:write': 'Create or change files',
  'filesystem:read': 'Read files',
  'network:fetch': 'Look things up on the web',
  'network:outbound': 'Send or fetch data over the internet',
  'network:listen': 'Open a network port',
  'credentials:read': 'Read passwords, keys or tokens',
  'system:persistence': 'Start itself automatically',
  'system:admin': 'Change system settings / use sudo',
  'browser:control': 'Control a web browser',
  'memory:write': 'Save to Jarvis memory',
  'agent:spawn': 'Start helper agents',
};

export const capabilityLabel = (cap: string): string => CAPABILITY_LABELS[cap] || cap;

export function cliInstallCommand(s: Pick<SkillReview, 'install_command' | 'rating'>): string {
  if (!s.install_command) return '';
  if (s.rating === 'unsafe') return `${s.install_command} --override-unsafe`;
  return s.install_command;
}
