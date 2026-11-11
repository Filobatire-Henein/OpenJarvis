import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  Puzzle,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import {
  capabilityLabel,
  cliInstallCommand,
  fetchInstalledSkills,
  fetchSkillCatalog,
  installSkill,
  removeSkill,
  reviewSkill,
  type SkillRating,
  type SkillReview,
} from '../lib/skills-api';

// ---------------------------------------------------------------------------
// Rating badge
// ---------------------------------------------------------------------------

const RATING_META: Record<SkillRating, { label: string; color: string; bg: string }> = {
  recommended: {
    label: 'Recommended',
    color: 'var(--color-success)',
    bg: 'color-mix(in srgb, var(--color-success) 14%, transparent)',
  },
  useful: {
    label: 'Useful',
    color: 'var(--color-success)',
    bg: 'color-mix(in srgb, var(--color-success) 10%, transparent)',
  },
  caution: {
    label: 'Caution',
    color: 'var(--color-warning)',
    bg: 'color-mix(in srgb, var(--color-warning) 14%, transparent)',
  },
  unsafe: {
    label: 'Unsafe',
    color: 'var(--color-error)',
    bg: 'color-mix(in srgb, var(--color-error) 14%, transparent)',
  },
};

export function RatingBadge({ rating }: { rating: SkillRating }) {
  const meta = RATING_META[rating] ?? RATING_META.useful;
  const Icon =
    rating === 'unsafe' ? ShieldAlert : rating === 'caution' ? AlertTriangle : ShieldCheck;
  return (
    <span
      data-rating={rating}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide shrink-0"
      style={{ color: meta.color, background: meta.bg, border: `1px solid ${meta.color}` }}
    >
      <Icon size={11} /> {meta.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Skill card
// ---------------------------------------------------------------------------

interface SkillCardProps {
  skill: SkillReview;
  mode: 'installed' | 'browse';
  busy?: boolean;
  onInstall?: (s: SkillReview) => void;
  onRemove?: (s: SkillReview) => void;
  onExplain?: (s: SkillReview) => void;
}

export function SkillCard({ skill, mode, busy, onInstall, onRemove, onExplain }: SkillCardProps) {
  const [copied, setCopied] = useState(false);
  const cmd = cliInstallCommand(skill);
  const origin = `${skill.source}${skill.category ? `:${skill.category}` : ''}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div
      className="rounded-xl p-4 flex flex-col gap-3"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm" style={{ color: 'var(--color-text)' }}>
              {skill.name}
            </span>
            <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
              {origin} · score {skill.score}/100
            </span>
          </div>
          {skill.description && (
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-secondary)' }}>
              {skill.description}
            </p>
          )}
        </div>
        <RatingBadge rating={skill.rating} />
      </div>

      <div>
        <div className="text-[11px] font-medium mb-1" style={{ color: 'var(--color-text-tertiary)' }}>
          Why
        </div>
        <ul className="text-xs space-y-0.5 list-disc pl-4" style={{ color: 'var(--color-text-secondary)' }}>
          {skill.reasons.slice(0, 4).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {skill.usefulness && (
          <p className="text-xs mt-1.5" style={{ color: 'var(--color-text-secondary)' }}>
            <span className="font-medium" style={{ color: 'var(--color-text)' }}>Usefulness: </span>
            {skill.usefulness}
          </p>
        )}
        {skill.summary && (
          <p className="text-xs mt-1.5 italic" style={{ color: 'var(--color-text-secondary)' }}>
            {skill.summary}
          </p>
        )}
      </div>

      {skill.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {skill.capabilities.map((c) => (
            <span
              key={c}
              className="text-[11px] px-2 py-0.5 rounded-md"
              style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)' }}
            >
              {capabilityLabel(c)}
            </span>
          ))}
        </div>
      )}

      {mode === 'browse' && (
        <div
          className="rounded-lg p-2.5 flex flex-col gap-2"
          style={{ background: 'var(--color-bg-secondary)' }}
        >
          <div className="text-[11px] font-medium" style={{ color: 'var(--color-text-tertiary)' }}>
            How to add
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              disabled={busy || skill.installed}
              onClick={() => onInstall?.(skill)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: skill.rating === 'unsafe' ? 'transparent' : 'var(--color-accent)',
                color: skill.rating === 'unsafe' ? 'var(--color-error)' : 'var(--color-on-accent)',
                border: skill.rating === 'unsafe' ? '1px solid var(--color-error)' : 'none',
              }}
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : skill.installed ? <Check size={12} /> : <Puzzle size={12} />}
              {skill.installed ? 'Installed' : skill.rating === 'unsafe' ? 'Blocked — review' : 'Add skill'}
            </button>
            {onExplain && (
              <button
                type="button"
                onClick={() => onExplain(skill)}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs cursor-pointer"
                style={{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
                title="Ask the local model for a plain-English summary"
              >
                <Sparkles size={12} /> Explain
              </button>
            )}
          </div>
          {cmd && (
            <div className="flex items-center gap-2">
              <code
                className="flex-1 text-[11px] px-2 py-1 rounded-md overflow-x-auto whitespace-nowrap"
                style={{ background: 'var(--color-code-bg)', color: 'var(--color-text)' }}
              >
                {cmd}
              </code>
              <button
                type="button"
                onClick={copy}
                aria-label="Copy command"
                className="p-1 rounded-md cursor-pointer"
                style={{ color: 'var(--color-text-tertiary)' }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </div>
          )}
        </div>
      )}

      {mode === 'installed' && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
            {skill.installed_at ? `Added ${skill.installed_at.slice(0, 10)}` : ''}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => onRemove?.(skill)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50"
            style={{ color: 'var(--color-error)', border: '1px solid var(--color-border)' }}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Remove
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirmation dialog
// ---------------------------------------------------------------------------

function ConfirmInstallDialog({
  skill,
  onCancel,
  onConfirm,
}: {
  skill: SkillReview | null;
  onCancel: () => void;
  onConfirm: (override: boolean) => void;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => setTyped(''), [skill]);
  if (!skill) return null;
  const unsafe = skill.rating === 'unsafe';
  const canConfirm = !unsafe || typed.trim() === skill.name;
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Add “{skill.name}”? <RatingBadge rating={skill.rating} />
          </DialogTitle>
          <DialogDescription>
            {unsafe
              ? 'Jarvis rated this skill UNSAFE and blocks it by default. Only continue if you know exactly what it does.'
              : skill.rating === 'caution'
                ? 'Jarvis found risks in this skill. Read them before adding it.'
                : 'Jarvis reviewed this skill and found no risky behaviour.'}
          </DialogDescription>
        </DialogHeader>
        <div className="text-xs space-y-2" style={{ color: 'var(--color-text-secondary)' }}>
          <div>
            <div className="font-medium mb-1" style={{ color: 'var(--color-text)' }}>Risks found</div>
            <ul className="list-disc pl-4 space-y-0.5">
              {skill.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
          {skill.capabilities.length > 0 && (
            <div>
              <div className="font-medium mb-1" style={{ color: 'var(--color-text)' }}>It could</div>
              <ul className="list-disc pl-4 space-y-0.5">
                {skill.capabilities.map((c) => (
                  <li key={c}>{capabilityLabel(c)}</li>
                ))}
              </ul>
            </div>
          )}
          {skill.has_scripts && (
            <p>Bundled scripts are not installed from here (CLI only, with --with-scripts).</p>
          )}
          {unsafe && (
            <label className="block">
              <span className="block mb-1" style={{ color: 'var(--color-error)' }}>
                Type <b>{skill.name}</b> to override the block:
              </span>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                className="w-full px-2 py-1 rounded-md text-xs"
                style={{
                  background: 'var(--color-input-bg)',
                  border: '1px solid var(--color-input-border)',
                  color: 'var(--color-text)',
                }}
              />
            </label>
          )}
        </div>
        <DialogFooter>
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-xs cursor-pointer"
            style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={() => onConfirm(unsafe)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: unsafe ? 'var(--color-error)' : 'var(--color-accent)',
              color: 'var(--color-on-accent)',
            }}
          >
            {unsafe ? 'Install anyway' : 'Add skill'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Tab = 'installed' | 'browse';
const SOURCES = [
  { id: '', label: 'All sources' },
  { id: 'hermes', label: 'Hermes' },
  { id: 'openclaw', label: 'OpenClaw' },
];
const RATING_FILTERS: { id: '' | SkillRating; label: string }[] = [
  { id: '', label: 'All ratings' },
  { id: 'recommended', label: 'Recommended' },
  { id: 'useful', label: 'Useful' },
  { id: 'caution', label: 'Caution' },
  { id: 'unsafe', label: 'Unsafe' },
];

export function SkillsPage() {
  const [tab, setTab] = useState<Tab>('installed');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('hermes');
  const [ratingFilter, setRatingFilter] = useState<'' | SkillRating>('');
  const [installed, setInstalled] = useState<SkillReview[] | null>(null);
  const [catalog, setCatalog] = useState<SkillReview[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>('');
  const [confirming, setConfirming] = useState<SkillReview | null>(null);

  const loadInstalled = useCallback(async () => {
    setLoading(true);
    try {
      setInstalled(await fetchInstalledSkills());
    } catch (e) {
      toast.error(`Could not load installed skills: ${(e as Error).message}`);
      setInstalled([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCatalog = useCallback(
    async (refresh = false) => {
      setLoading(true);
      try {
        const data = await fetchSkillCatalog({ source, refresh });
        setCatalog(data.skills);
        setErrors(data.errors.map((e) => `${e.source}: ${e.error}`));
      } catch (e) {
        setErrors([(e as Error).message]);
        setCatalog([]);
      } finally {
        setLoading(false);
      }
    },
    [source],
  );

  useEffect(() => {
    if (tab === 'installed') void loadInstalled();
    else void loadCatalog(false);
  }, [tab, loadInstalled, loadCatalog]);

  const list = tab === 'installed' ? installed : catalog;
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return (list || []).filter(
      (s) =>
        (!ratingFilter || s.rating === ratingFilter) &&
        (!q || `${s.name} ${s.description} ${s.category}`.toLowerCase().includes(q)),
    );
  }, [list, query, ratingFilter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of list || []) c[s.rating] = (c[s.rating] || 0) + 1;
    return c;
  }, [list]);

  const doInstall = async (skill: SkillReview, override: boolean) => {
    setConfirming(null);
    setBusy(skill.name);
    try {
      const res = await installSkill({
        source: skill.source,
        name: skill.name,
        category: skill.category,
        confirm: true,
        override_unsafe: override,
      });
      if (res.status === 'installed' || res.status === 'already_installed') {
        toast.success(`Added ${skill.name}`);
        setCatalog((prev) => prev?.map((s) => (s.name === skill.name && s.source === skill.source ? { ...s, installed: true } : s)) ?? null);
        setInstalled(null);
      } else {
        toast.error(res.message);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const doRemove = async (skill: SkillReview) => {
    if (!window.confirm(`Remove the skill "${skill.name}"?`)) return;
    setBusy(skill.name);
    try {
      await removeSkill(skill.name);
      toast.success(`Removed ${skill.name}`);
      await loadInstalled();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const doExplain = async (skill: SkillReview) => {
    setBusy(skill.name);
    try {
      const r = await reviewSkill({
        source: skill.source,
        name: skill.name,
        category: skill.category,
        explain: true,
      });
      if (!r.summary) toast.info('The local model is not available right now.');
      setCatalog((prev) => prev?.map((s) => (s.name === skill.name && s.source === skill.source ? { ...s, summary: r.summary } : s)) ?? null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const tabBtn = (id: Tab, label: string) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
      style={{
        background: tab === id ? 'var(--color-accent-subtle)' : 'transparent',
        color: tab === id ? 'var(--color-text)' : 'var(--color-text-secondary)',
      }}
    >
      {label}
    </button>
  );
  const selectStyle = {
    background: 'var(--color-bg-secondary)',
    color: 'var(--color-text-secondary)',
    border: '1px solid var(--color-border)',
  };

  return (
    <div className="flex-1 overflow-y-auto px-6 py-10" style={{ background: 'var(--color-bg)' }}>
      <div className="max-w-5xl mx-auto w-full">
        <header className="mb-6">
          <div className="flex items-center gap-2">
            <Puzzle size={18} style={{ color: 'var(--color-accent)' }} />
            <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
              Skills
            </h1>
          </div>
          <p className="text-sm mt-2 max-w-2xl" style={{ color: 'var(--color-text-secondary)' }}>
            Skills teach Jarvis new routines. Jarvis reviews every skill before it’s added. Unsafe
            skills are blocked. Reviews run on this computer — nothing is sent to the cloud.
          </p>
        </header>

        <div className="flex items-center gap-2 flex-wrap mb-4">
          <div className="flex items-center gap-1 rounded-lg p-0.5" style={{ border: '1px solid var(--color-border)' }}>
            {tabBtn('installed', `Installed${installed ? ` (${installed.length})` : ''}`)}
            {tabBtn('browse', 'Browse')}
          </div>
          <div className="relative flex-1 min-w-[180px]">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-text-tertiary)' }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills"
              className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs outline-none"
              style={{
                background: 'var(--color-input-bg)',
                border: '1px solid var(--color-input-border)',
                color: 'var(--color-text)',
              }}
            />
          </div>
          <select
            value={ratingFilter}
            onChange={(e) => setRatingFilter(e.target.value as '' | SkillRating)}
            className="px-2 py-1.5 rounded-lg text-xs"
            style={selectStyle}
            aria-label="Filter by rating"
          >
            {RATING_FILTERS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
                {r.id && counts[r.id] ? ` (${counts[r.id]})` : ''}
              </option>
            ))}
          </select>
          {tab === 'browse' && (
            <>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="px-2 py-1.5 rounded-lg text-xs"
                style={selectStyle}
                aria-label="Skill source"
              >
                {SOURCES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void loadCatalog(true)}
                disabled={loading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs cursor-pointer disabled:opacity-50"
                style={selectStyle}
              >
                <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
              </button>
            </>
          )}
        </div>

        {errors.length > 0 && tab === 'browse' && (
          <div
            className="mb-4 rounded-lg p-3 text-xs"
            style={{ color: 'var(--color-warning)', border: '1px solid var(--color-warning)' }}
          >
            {errors.map((e) => (
              <div key={e}>{e}</div>
            ))}
          </div>
        )}

        {loading && !list ? (
          <div className="flex items-center gap-2 text-sm py-12 justify-center" style={{ color: 'var(--color-text-tertiary)' }}>
            <Loader2 size={14} className="animate-spin" />
            {tab === 'browse' ? 'Fetching and reviewing skills…' : 'Loading…'}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
            {tab === 'installed'
              ? 'No skills installed yet. Open Browse to see what you can add.'
              : 'No skills match.'}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {filtered.map((s) => (
              <SkillCard
                key={`${s.source}:${s.category}/${s.name}`}
                skill={s}
                mode={tab}
                busy={busy === s.name}
                onInstall={(sk) => setConfirming(sk)}
                onRemove={doRemove}
                onExplain={tab === 'browse' ? doExplain : undefined}
              />
            ))}
          </div>
        )}
      </div>
      <ConfirmInstallDialog
        skill={confirming}
        onCancel={() => setConfirming(null)}
        onConfirm={(override) => confirming && void doInstall(confirming, override)}
      />
    </div>
  );
}
