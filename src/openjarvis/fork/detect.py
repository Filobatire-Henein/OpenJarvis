"""Detect whether OpenJarvis is running from the Filo fork.

Detection is deliberately cheap (plain file reads, no subprocess, no
network) so it can run on every CLI invocation. A checkout counts as the
fork when **any** of these hold:

1. ``OPENJARVIS_FORK=1`` is set (``OPENJARVIS_FORK=0`` forces "not a fork").
2. The repo root contains the ``.openjarvis-fork`` marker file.
3. The ``origin`` remote URL points at the fork repository.
4. The checked-out branch is the fork's main branch (``filo-main``).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

FORK_MARKER = ".openjarvis-fork"
FORK_REPO_SLUG = "filobatire-henein/openjarvis"
FORK_BRANCH = "filo-main"
UPSTREAM_URL = "https://github.com/open-jarvis/OpenJarvis.git"

FORK_REFUSAL_MESSAGE = (
    "This is the Filo fork — use the Updates tab / `jarvis fork-updates`."
)

_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"0", "false", "no", "off"}


@dataclass(frozen=True)
class ForkInfo:
    """Result of :func:`detect_fork`."""

    is_fork: bool
    repo_root: Optional[Path] = None
    origin_url: str = ""
    branch: str = ""
    reasons: List[str] = field(default_factory=list)


def find_repo_root(start: Optional[Path] = None) -> Optional[Path]:
    """Walk up from *start* (default: the installed package) to a git root."""
    if start is None:
        try:
            import openjarvis

            start = Path(openjarvis.__file__).resolve().parent
        except Exception:
            return None
    candidate = Path(start).resolve()
    for _ in range(10):
        if (candidate / ".git").exists():
            return candidate
        if candidate.parent == candidate:
            break
        candidate = candidate.parent
    return None


def _git_dirs(repo_root: Path) -> tuple[Optional[Path], Optional[Path]]:
    """Return ``(gitdir, commondir)`` for a checkout, handling worktrees."""
    dot_git = repo_root / ".git"
    if dot_git.is_dir():
        return dot_git, dot_git
    if dot_git.is_file():
        try:
            text = dot_git.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None, None
        m = re.match(r"gitdir:\s*(.+)", text.strip())
        if not m:
            return None, None
        gitdir = Path(m.group(1).strip())
        if not gitdir.is_absolute():
            gitdir = (repo_root / gitdir).resolve()
        common = gitdir
        try:
            rel = (gitdir / "commondir").read_text().strip()
            common = (gitdir / rel).resolve()
        except OSError:
            pass
        return gitdir, common
    return None, None


def read_origin_url(repo_root: Path) -> str:
    """Read ``remote.origin.url`` straight from ``.git/config``."""
    _, common = _git_dirs(repo_root)
    if common is None:
        return ""
    try:
        text = (common / "config").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    in_origin = False
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("["):
            in_origin = bool(re.match(r'\[remote\s+"origin"\]', line))
            continue
        if in_origin:
            m = re.match(r"url\s*=\s*(.+)", line)
            if m:
                return m.group(1).strip()
    return ""


def read_branch(repo_root: Path) -> str:
    """Return the checked-out branch name ("" when detached/unknown)."""
    gitdir, _ = _git_dirs(repo_root)
    if gitdir is None:
        return ""
    try:
        head = (gitdir / "HEAD").read_text().strip()
    except OSError:
        return ""
    prefix = "ref: refs/heads/"
    return head[len(prefix) :] if head.startswith(prefix) else ""


def detect_fork(repo_root: Optional[Path] = None, *, search: bool = True) -> ForkInfo:
    """Decide whether *repo_root* is the fork.

    When *repo_root* is ``None`` and *search* is true, the repo containing the
    running ``openjarvis`` package is inspected. With ``search=False`` only the
    ``OPENJARVIS_FORK`` environment variable is consulted.
    """
    env = os.environ.get("OPENJARVIS_FORK", "").strip().lower()
    if repo_root is not None:
        root: Optional[Path] = Path(repo_root)
    else:
        root = find_repo_root() if search else None
    if env in _FALSY:
        return ForkInfo(is_fork=False, repo_root=root, reasons=["OPENJARVIS_FORK=0"])

    reasons: List[str] = []
    if env in _TRUTHY:
        reasons.append("OPENJARVIS_FORK=1")

    origin = ""
    branch = ""
    if root is not None:
        if (root / FORK_MARKER).exists():
            reasons.append(f"{FORK_MARKER} marker present")
        origin = read_origin_url(root)
        normalized = origin.lower().replace(":", "/")
        if FORK_REPO_SLUG in normalized:
            reasons.append(f"origin is the fork ({origin})")
        branch = read_branch(root)
        if branch == FORK_BRANCH:
            reasons.append(f"on branch {FORK_BRANCH}")

    return ForkInfo(
        is_fork=bool(reasons),
        repo_root=root,
        origin_url=origin,
        branch=branch,
        reasons=reasons,
    )


def is_fork_checkout(repo_root: Optional[Path] = None) -> bool:
    """Best-effort boolean wrapper around :func:`detect_fork`; never raises."""
    try:
        return detect_fork(repo_root).is_fork
    except Exception:
        return False
