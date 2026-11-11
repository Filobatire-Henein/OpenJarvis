"""Skill advisor service — shared by the CLI and the ``/v1/skills`` API.

Everything here runs locally.  Network access only happens inside
``resolver.sync()`` (a ``git clone``/``pull`` of a skill source), which is
triggered when the user opens the catalog for a source that has never been
fetched, or explicitly asks for a refresh.
"""

from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from openjarvis.core.paths import get_config_dir
from openjarvis.skills.advisor import (
    ReviewStore,
    SkillReview,
    SkillReviewer,
    gate_install,
    split_skill_md,
)

LOGGER = logging.getLogger(__name__)

KNOWN_SOURCES = ("hermes", "openclaw")


class AdvisorError(Exception):
    """User-facing error (bad source, skill not found, ...)."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def skills_root() -> Path:
    return get_config_dir() / "skills"


def get_resolver(source: str, url: str = ""):
    """Return a resolver for *source* (``hermes`` / ``openclaw`` / ``github``)."""
    if source == "hermes":
        from openjarvis.skills.sources.hermes import HermesResolver

        return HermesResolver()
    if source == "openclaw":
        from openjarvis.skills.sources.openclaw import OpenClawResolver

        return OpenClawResolver()
    if source == "github":
        if not url:
            raise AdvisorError("github source requires a repository url")
        if not url.startswith("https://github.com/"):
            raise AdvisorError("Only https://github.com/ repository URLs are supported")
        from openjarvis.skills.sources.github import GitHubResolver

        slug = url.rstrip("/").removesuffix(".git").rsplit("/", 1)[-1]
        return GitHubResolver(
            cache_root=get_config_dir() / "skill-cache" / "github" / slug,
            repo_url=url,
        )
    raise AdvisorError(f"Unknown source: {source!r}")


def configured_sources() -> List[Dict[str, str]]:
    """Sources from ``[skills.sources]``; falls back to the two public catalogs."""
    out: List[Dict[str, str]] = []
    try:
        from openjarvis.core.config import load_config

        for src in load_config().skills.sources:
            out.append({"source": src.source, "url": src.url or ""})
    except Exception:  # noqa: BLE001 - defaults below
        LOGGER.debug("Could not read skill sources from config", exc_info=True)
    known = {s["source"] for s in out}
    for name in KNOWN_SOURCES:
        if name not in known:
            out.append({"source": name, "url": ""})
    return out


def _is_cached(resolver: Any) -> bool:
    try:
        return (Path(resolver.cache_dir()) / ".git").exists()
    except Exception:  # noqa: BLE001
        return False


def ensure_synced(resolver: Any, *, refresh: bool = False) -> str:
    """Fetch the source if never fetched (or if *refresh*). Returns a warning."""
    if refresh or not _is_cached(resolver):
        resolver.sync()
    return getattr(resolver, "refresh_warning", "") or ""


def review_resolved(
    resolved: Any,
    *,
    reviewer: Optional[SkillReviewer] = None,
    store: Optional[ReviewStore] = None,
    use_cache: bool = True,
) -> SkillReview:
    """Review a resolved skill, reusing a stored review for the same commit."""
    store = store or ReviewStore()
    if use_cache and getattr(resolved, "commit", ""):
        cached = store.get(resolved.source, resolved.category, resolved.name)
        if cached is not None and cached.commit == resolved.commit:
            return cached
    review = (reviewer or SkillReviewer()).review_resolved(resolved)
    try:
        store.put(review)
    except OSError:
        LOGGER.warning("Could not record skill review", exc_info=True)
    return review


def find_resolved(resolver: Any, name: str, category: str = "") -> Any:
    if "/" in name and not category:
        category, _, name = name.partition("/")
    matches = [
        s
        for s in resolver.list_skills()
        if s.name == name and (not category or s.category == category)
    ]
    if not matches:
        raise AdvisorError(f"No skill named '{name}' found", status=404)
    return matches[0]


def catalog(
    source: str = "",
    q: str = "",
    *,
    refresh: bool = False,
    url: str = "",
) -> Dict[str, Any]:
    """List available skills (with reviews) from one or all sources."""
    sources = configured_sources()
    if source:
        sources = [s for s in sources if s["source"] == source] or [
            {"source": source, "url": url}
        ]
        if url:
            sources = [{"source": source, "url": url}]
    reviewer = SkillReviewer()
    store = ReviewStore()
    installed = {item["name"] for item in list_installed(review=False)}
    items: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []
    ql = q.lower().strip()
    for src in sources:
        try:
            resolver = get_resolver(src["source"], src["url"])
            warning = ensure_synced(resolver, refresh=refresh)
            if warning:
                errors.append({"source": src["source"], "error": warning})
        except AdvisorError:
            raise
        except Exception as exc:  # noqa: BLE001 - surface per-source failure
            errors.append({"source": src["source"], "error": str(exc)})
            continue
        for resolved in resolver.list_skills():
            hay = f"{resolved.name} {resolved.description} {resolved.category}".lower()
            if ql and ql not in hay:
                continue
            review = review_resolved(resolved, reviewer=reviewer, store=store)
            entry = review.to_dict()
            entry["installed"] = resolved.name in installed
            items.append(entry)
    order = {"recommended": 0, "useful": 1, "caution": 2, "unsafe": 3}
    items.sort(key=lambda r: (order.get(r["rating"], 9), -r["score"], r["name"]))
    return {
        "skills": items,
        "errors": errors,
        "sources": [s["source"] for s in sources],
    }


def review_one(
    source: str,
    name: str,
    *,
    category: str = "",
    url: str = "",
    explain: bool = False,
) -> SkillReview:
    if source in ("", "local", "installed"):
        path = _installed_path(name)
        review = SkillReviewer().review_path(path, name=name, source="local")
    else:
        resolver = get_resolver(source, url)
        ensure_synced(resolver)
        resolved = find_resolved(resolver, name, category)
        review = review_resolved(resolved, use_cache=not explain)
        path = Path(resolved.path)
    if explain:
        from openjarvis.skills.advisor import summarize_with_local_model

        md = path / "SKILL.md"
        text = md.read_text(encoding="utf-8", errors="replace") if md.exists() else ""
        review.summary = summarize_with_local_model(review, text)
        try:
            ReviewStore().put(review)
        except OSError:
            pass
    return review


@dataclass
class InstallOutcome:
    status: str  # installed | already_installed | needs_confirmation | blocked | failed
    message: str
    review: SkillReview
    target_path: str = ""
    warnings: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "message": self.message,
            "review": self.review.to_dict(),
            "target_path": self.target_path,
            "warnings": self.warnings,
        }


def install(
    source: str,
    name: str,
    *,
    category: str = "",
    url: str = "",
    confirm: bool = False,
    override_unsafe: bool = False,
    with_scripts: bool = False,
    force: bool = False,
) -> InstallOutcome:
    """Review then (if the gate allows) install a skill.

    The API always requires ``confirm=True``; this is the user's explicit
    "yes" after seeing the review.  Confirming also covers the dangerous-
    capability check (the API equivalent of ``--yes-dangerous``) because the
    confirmation dialog lists those capabilities.
    """
    resolver = get_resolver(source, url)
    ensure_synced(resolver)
    resolved = find_resolved(resolver, name, category)
    review = review_resolved(resolved, use_cache=False)
    store = ReviewStore()
    if not confirm:
        return InstallOutcome(
            "needs_confirmation",
            "Review the risks and confirm to install.",
            review,
        )
    decision = gate_install(review, confirmed=confirm, override_unsafe=override_unsafe)
    if not decision.allowed:
        store.put(review, decision="blocked")
        return InstallOutcome(
            "needs_confirmation" if decision.needs_confirmation else "blocked",
            decision.message,
            review,
        )

    from openjarvis.skills.importer import SkillImporter
    from openjarvis.skills.parser import SkillParser
    from openjarvis.skills.tool_translator import ToolTranslator

    importer = SkillImporter(parser=SkillParser(), tool_translator=ToolTranslator())
    result = importer.import_skill(
        resolved,
        with_scripts=with_scripts,
        force=force,
        confirm_dangerous=confirm,
    )
    if not result.success:
        return InstallOutcome(
            "failed",
            "; ".join(result.warnings or ["Install failed"]),
            review,
            warnings=list(result.warnings),
        )
    store.put(review, decision="installed" if not result.skipped else "")
    return InstallOutcome(
        "already_installed" if result.skipped else "installed",
        "Already installed" if result.skipped else decision.message,
        review,
        target_path=str(result.target_path or ""),
        warnings=list(result.warnings),
    )


def _skill_dirs(root: Path) -> List[Path]:
    if not root.exists():
        return []
    dirs = []
    for md in sorted(root.rglob("SKILL.md")):
        if any(part.startswith(".") for part in md.relative_to(root).parts):
            continue
        dirs.append(md.parent)
    for toml in sorted(root.rglob("skill.toml")):
        if toml.parent not in dirs:
            dirs.append(toml.parent)
    return dirs


def _read_source_meta(path: Path) -> Dict[str, Any]:
    meta = path / ".source"
    if not meta.exists():
        return {}
    try:
        import tomllib
    except ModuleNotFoundError:  # pragma: no cover
        import tomli as tomllib  # type: ignore[no-redef]
    try:
        return tomllib.loads(meta.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def list_installed(*, review: bool = True) -> List[Dict[str, Any]]:
    """Skills installed in the user's skills directory."""
    root = skills_root()
    reviewer = SkillReviewer() if review else None
    out: List[Dict[str, Any]] = []
    for path in _skill_dirs(root):
        meta = _read_source_meta(path)
        name = path.name
        md = path / "SKILL.md"
        description = ""
        if md.exists():
            fm, _ = split_skill_md(md.read_text(encoding="utf-8", errors="replace"))
            name = str(fm.get("name") or name)
            description = str(fm.get("description") or "")
        src_full = str(meta.get("source", ""))
        source = src_full.split(":", 1)[0] if src_full else "local"
        entry: Dict[str, Any] = {
            "name": name,
            "source": source,
            "category": str(meta.get("category", "")),
            "description": description[:400],
            "path": str(path),
            "installed_at": str(meta.get("installed_at", "")),
            "scripts_imported": bool(meta.get("scripts_imported", False)),
            "installed": True,
        }
        if reviewer is not None:
            r = reviewer.review_path(
                path, name=name, source=source, category=entry["category"]
            )
            entry.update({k: v for k, v in r.to_dict().items() if k not in entry})
            entry["install_command"] = ""
        out.append(entry)
    return out


def _installed_path(name: str) -> Path:
    for path in _skill_dirs(skills_root()):
        if path.name == name:
            return path
        md = path / "SKILL.md"
        if md.exists():
            fm, _ = split_skill_md(md.read_text(encoding="utf-8", errors="replace"))
            if fm.get("name") == name:
                return path
    raise AdvisorError(f"No installed skill named '{name}'", status=404)


def remove(name: str) -> List[str]:
    """Remove an installed skill from the user skills directory only."""
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise AdvisorError("Invalid skill name")
    root = skills_root().resolve()
    removed: List[str] = []
    for path in _skill_dirs(root):
        matches = path.name == name
        if not matches and (path / "SKILL.md").exists():
            fm, _ = split_skill_md(
                (path / "SKILL.md").read_text(encoding="utf-8", errors="replace")
            )
            matches = fm.get("name") == name
        if not matches:
            continue
        resolved = path.resolve()
        if root not in resolved.parents:
            continue
        shutil.rmtree(resolved)
        removed.append(str(resolved))
    if not removed:
        raise AdvisorError(f"No installed skill named '{name}'", status=404)
    return removed


__all__ = [
    "AdvisorError",
    "InstallOutcome",
    "catalog",
    "configured_sources",
    "ensure_synced",
    "find_resolved",
    "get_resolver",
    "install",
    "list_installed",
    "remove",
    "review_one",
    "review_resolved",
]
