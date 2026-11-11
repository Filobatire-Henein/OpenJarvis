import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { RatingBadge, SkillCard } from './SkillsPage';
import { cliInstallCommand, installSkill, fetchSkillCatalog, type SkillReview } from '../lib/skills-api';

const base: SkillReview = {
  name: 'weekly-review',
  source: 'hermes',
  category: 'productivity',
  description: 'Plan your week',
  rating: 'recommended',
  score: 100,
  reasons: ['No risky behaviour found in its instructions or files.'],
  capabilities: [],
  usefulness: 'Instruction-only and works with the tools you already have enabled.',
  findings: [],
  needed_tools: [],
  missing_tools: [],
  has_scripts: false,
  script_files: [],
  install_command: 'jarvis skill install hermes:productivity/weekly-review',
  summary: '',
  blocked: false,
  needs_confirmation: false,
};

describe('SkillCard', () => {
  it('shows rating, reasons and how to add', () => {
    const html = renderToStaticMarkup(<SkillCard skill={base} mode="browse" />);
    expect(html).toContain('data-rating="recommended"');
    expect(html).toContain('No risky behaviour found');
    expect(html).toContain('How to add');
    expect(html).toContain('jarvis skill install hermes:productivity/weekly-review');
    expect(html).toContain('Add skill');
  });

  it('marks unsafe skills as blocked and lists capabilities', () => {
    const unsafe: SkillReview = {
      ...base,
      name: 'evil',
      rating: 'unsafe',
      blocked: true,
      reasons: ['Downloads a script from the internet and runs it immediately.'],
      capabilities: ['shell:execute', 'credentials:read'],
    };
    const html = renderToStaticMarkup(<SkillCard skill={unsafe} mode="browse" />);
    expect(html).toContain('data-rating="unsafe"');
    expect(html).toContain('Blocked');
    expect(html).toContain('Run shell commands / programs');
    expect(html).toContain('Read passwords, keys or tokens');
    expect(html).toContain('--override-unsafe');
  });

  it('installed mode shows a remove button', () => {
    const html = renderToStaticMarkup(<SkillCard skill={base} mode="installed" />);
    expect(html).toContain('Remove');
    expect(html).not.toContain('How to add');
  });

  it('badge colours follow rating', () => {
    expect(renderToStaticMarkup(<RatingBadge rating="caution" />)).toContain('--color-warning');
    expect(renderToStaticMarkup(<RatingBadge rating="useful" />)).toContain('--color-success');
  });
});

describe('skills api', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('cli command adds override flag only for unsafe', () => {
    expect(cliInstallCommand(base)).toBe(base.install_command);
    expect(cliInstallCommand({ ...base, rating: 'unsafe' })).toContain('--override-unsafe');
  });

  it('install posts confirm and returns blocked responses instead of throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'blocked', message: 'no', review: base }), { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await installSkill({ source: 'hermes', name: 'evil', confirm: true });
    expect(res.status).toBe('blocked');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/v1/skills/install');
    expect(JSON.parse(init.body).confirm).toBe(true);
  });

  it('catalog builds the query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ skills: [], errors: [], sources: ['hermes'] })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fetchSkillCatalog({ source: 'hermes', q: 'notes', refresh: true });
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/v1/skills/catalog?source=hermes&q=notes&refresh=true',
    );
  });
});
