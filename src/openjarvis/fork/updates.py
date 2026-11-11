"""Read-only "what's in the upstream update?" report for the fork.

Nothing here ever merges, checks out, resets or otherwise touches the
working tree or branches. The only write-ish git operations are:

* ``git fetch upstream`` — only when the caller explicitly asks for a
  refresh (the user opened the Updates tab or clicked "Check now").
* ``git merge-tree --write-tree`` — writes loose objects for a *virtual*
  merge so we can predict conflicts; no refs or files change.

The report is a plain JSON-serialisable ``dict`` consumed by both
``GET /v1/fork/updates`` and ``jarvis fork-updates``.
"""

from __future__ import annotations

import datetime as _dt
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from openjarvis.fork.detect import UPSTREAM_URL, detect_fork, find_repo_root

MAX_COMMITS = 300
FETCH_TIMEOUT_S = 120
GIT_TIMEOUT_S = 60

VERDICT_SAFE = "safe"
VERDICT_REVIEW = "review"
VERDICT_CONFLICT = "will conflict"
_VERDICT_RANK = {VERDICT_SAFE: 0, VERDICT_REVIEW: 1, VERDICT_CONFLICT: 2}

GROUP_ORDER = ["security", "features", "fixes", "docs", "chore", "other"]

# ---------------------------------------------------------------------------
# Risk rules
# ---------------------------------------------------------------------------

_DEP_FILES = {
    "pyproject.toml",
    "uv.lock",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.toml",
    "Cargo.lock",
}
_DEP_RE = re.compile(r"(^|/)requirements[^/]*\.txt$")

_CONFIG_FILES = {"src/openjarvis/core/config.py"}

_SPEECH_PREFIXES = ("src/openjarvis/speech/", "scripts/voice/")
_SPEECH_FILES = {"src/openjarvis/cli/_voice_chat.py"}

_DESKTOP_PERMISSION_RE = re.compile(
    r"(^|/)(Info\.plist|Entitlements\.plist|tauri\.conf\.json)$"
    r"|^frontend/src-tauri/capabilities/"
)

_ANALYTICS_PATH_RE = re.compile(
    r"(^|/)(analytics|telemetry)(/|[_.-])|posthog|sentry", re.IGNORECASE
)
_TRACKER_RE = re.compile(
    r"posthog|sentry_sdk|@sentry/|mixpanel|amplitude|segment\.(io|com)|"
    r"datadog|google-analytics|googletagmanager|gtag\(|ANALYTICS_(HOST|KEY)|phc_\w{10,}",
    re.IGNORECASE,
)
_NETWORK_RE = re.compile(
    r"requests\.(get|post|put|patch|delete|request|Session)\b|httpx\.|"
    r"urlopen\(|aiohttp\.|urllib3\.|reqwest::|"
    r"\bfetch\(\s*[`'\"]https?://|\bcurl\s+[^\n]*https?://|"
    r"navigator\.sendBeacon|new\s+WebSocket\(\s*[`'\"]wss?://",
)
_LOCAL_HOST_RE = re.compile(r"localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]")
_MEDIA_EXT = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".mp4")
_CODE_EXT = (".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".rs", ".sh", ".toml")

_SECURITY_SUBJECT_RE = re.compile(
    r"\bsecurity\b|\bCVE-\d|vulnerab|\bxss\b|injection|ssrf|"
    r"sanitiz|exfiltrat|\bauth(entication|orization)?\s+bypass",
    re.IGNORECASE,
)
_CONVENTIONAL_RE = re.compile(r"^(?P<type>[a-zA-Z]+)(\((?P<scope>[^)]*)\))?!?:")
_FIELD_RE = re.compile(r"^(?P<sign>[+-])\s{4}(?P<name>[a-z_][a-z0-9_]*)\s*:\s*[^=]+")


# ---------------------------------------------------------------------------
# git helpers
# ---------------------------------------------------------------------------


class GitError(RuntimeError):
    pass


def _git(
    repo: Path,
    *args: str,
    check: bool = True,
    timeout: int = GIT_TIMEOUT_S,
) -> subprocess.CompletedProcess:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"}
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=repo,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            env=env,
        )
    except FileNotFoundError as exc:
        raise GitError("git is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise GitError(f"git {args[0]} timed out after {timeout}s") from exc
    if check and proc.returncode != 0:
        raise GitError(proc.stderr.strip() or f"git {' '.join(args)} failed")
    return proc


def git_version(repo: Path) -> Tuple[int, int, int]:
    out = _git(repo, "--version").stdout
    m = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", out)
    if not m:
        return (0, 0, 0)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))


def _lines(text: str) -> List[str]:
    return [ln for ln in text.splitlines() if ln.strip()]


# ---------------------------------------------------------------------------
# conflict prediction
# ---------------------------------------------------------------------------


def predict_conflicts(
    repo: Path, ours: str, theirs: str, base: Optional[str] = None
) -> Tuple[List[str], str]:
    """Return ``(conflicting_files, method)`` without touching the work tree."""
    if git_version(repo) >= (2, 38, 0):
        proc = _git(
            repo,
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            ours,
            theirs,
            check=False,
        )
        if proc.returncode in (0, 1):
            lines = proc.stdout.splitlines()
            files = sorted({ln.strip() for ln in lines[1:] if ln.strip()})
            return (files if proc.returncode == 1 else []), "merge-tree --write-tree"
        raise GitError(proc.stderr.strip() or "git merge-tree failed")

    if base is None:
        base = _git(repo, "merge-base", ours, theirs).stdout.strip()
    proc = _git(repo, "merge-tree", base, ours, theirs, check=False)
    return parse_legacy_merge_tree(proc.stdout), "merge-tree (legacy)"


def parse_legacy_merge_tree(output: str) -> List[str]:
    """Parse the pre-2.38 ``git merge-tree <base> <a> <b>`` format."""
    conflicts: Set[str] = set()
    current: Optional[str] = None
    entry_re = re.compile(r"^\s+(base|our|their|result)\s+\d+\s+[0-9a-f]+\s+(.+)$")
    for line in output.splitlines():
        if line and not line[0].isspace() and not line.startswith(("+", "-", "@")):
            current = None  # new section header ("changed in both", ...)
            continue
        m = entry_re.match(line)
        if m:
            current = m.group(2)
            continue
        if current and line.startswith("+<<<<<<<"):
            conflicts.add(current)
    return sorted(conflicts)


# ---------------------------------------------------------------------------
# commit parsing
# ---------------------------------------------------------------------------

_COMMIT_MARK = "\x1e@@OJCOMMIT@@"


@dataclass
class _RawCommit:
    sha: str
    author: str
    date: str
    subject: str
    body: str
    files: List[str]
    added: Dict[str, List[str]]
    removed: Dict[str, List[str]]


def _parse_log(text: str) -> List[_RawCommit]:
    commits: List[_RawCommit] = []
    for chunk in text.split(_COMMIT_MARK):
        if not chunk.strip():
            continue
        header, _, rest = chunk.partition("\x1d")
        parts = header.split("\x1f")
        if len(parts) < 5:
            continue
        sha, author, date, subject, body = parts[:5]
        files: List[str] = []
        added: Dict[str, List[str]] = {}
        removed: Dict[str, List[str]] = {}
        current: Optional[str] = None
        for line in rest.splitlines():
            if line.startswith("diff --git "):
                m = re.match(r"diff --git a/(.+?) b/(.+)$", line)
                current = m.group(2) if m else None
                if current and current not in files:
                    files.append(current)
                continue
            if current is None or line.startswith(("+++", "---")):
                continue
            if line.startswith("+"):
                added.setdefault(current, []).append(line[1:])
            elif line.startswith("-"):
                removed.setdefault(current, []).append(line[1:])
        commits.append(
            _RawCommit(
                sha=sha.strip(),
                author=author,
                date=date,
                subject=subject.strip(),
                body=body.strip(),
                files=files,
                added=added,
                removed=removed,
            )
        )
    return commits


def classify_group(subject: str) -> str:
    """Bucket a commit by its conventional-commit prefix."""
    if _SECURITY_SUBJECT_RE.search(subject):
        return "security"
    m = _CONVENTIONAL_RE.match(subject)
    kind = (m.group("type").lower() if m else "").strip()
    scope = (m.group("scope") or "").lower() if m else ""
    if kind == "security" or "security" in scope:
        return "security"
    if kind in ("feat", "feature"):
        return "features"
    if kind in ("fix", "bugfix", "hotfix", "revert"):
        return "fixes"
    if kind == "docs":
        return "docs"
    if kind in ("chore", "ci", "build", "refactor", "test", "tests", "style", "perf"):
        return "chore"
    return "other"


# ---------------------------------------------------------------------------
# user config helpers
# ---------------------------------------------------------------------------


def _user_config_path() -> Path:
    override = os.environ.get("OPENJARVIS_CONFIG")
    if override:
        return Path(override).expanduser()
    from openjarvis.core.paths import get_config_dir

    return get_config_dir() / "config.toml"


def load_user_config_keys(path: Optional[Path] = None) -> Dict[str, List[str]]:
    """Map leaf key name -> dotted paths used in the user's config.toml."""
    path = path or _user_config_path()
    try:
        import tomllib
    except ImportError:  # pragma: no cover - py3.10
        try:
            import tomli as tomllib  # type: ignore[no-redef]
        except ImportError:
            return {}
    try:
        with open(path, "rb") as fh:
            data = tomllib.load(fh)
    except Exception:
        return {}

    out: Dict[str, List[str]] = {}

    def walk(node: Any, prefix: str) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                dotted = f"{prefix}.{key}" if prefix else key
                if isinstance(value, dict):
                    walk(value, dotted)
                out.setdefault(key, []).append(dotted)

    walk(data, "")
    return out


def removed_config_fields(added: Sequence[str], removed: Sequence[str]) -> List[str]:
    """Dataclass field names deleted (and not re-added) in a config.py diff."""

    def names(lines: Iterable[str], sign: str) -> Set[str]:
        found = set()
        for ln in lines:
            m = _FIELD_RE.match(sign + ln)
            if m:
                found.add(m.group("name"))
        return found

    return sorted(names(removed, "-") - names(added, "+"))


# ---------------------------------------------------------------------------
# per-commit analysis
# ---------------------------------------------------------------------------


def _short_list(items: Sequence[str], limit: int = 4) -> str:
    items = list(items)
    shown = ", ".join(items[:limit])
    return shown + (f" and {len(items) - limit} more" if len(items) > limit else "")


def _is_dep_file(path: str) -> bool:
    return Path(path).name in _DEP_FILES or bool(_DEP_RE.search(path))


def _is_shipped_file(path: str) -> bool:
    """False for tests, docs, examples and media that never run on the Mac."""
    lowered = path.lower()
    if lowered.endswith(_MEDIA_EXT):
        return False
    return not (
        lowered.startswith(("tests/", "docs/", "examples/"))
        or "/tests/" in lowered
        or ".test." in lowered
        or "/__tests__/" in lowered
        or lowered.endswith(".md")
    )


def _is_scannable_code(path: str) -> bool:
    if not path.endswith(_CODE_EXT) or _is_dep_file(path):
        return False
    return _is_shipped_file(path)


def analyze_commit(
    raw: _RawCommit,
    *,
    fork_files: Set[str],
    conflict_files: Set[str],
    user_config_keys: Dict[str, List[str]],
) -> Dict[str, Any]:
    files = raw.files
    flags: List[Dict[str, str]] = []
    reasons: List[str] = []

    def flag(kind: str, level: str, message: str) -> None:
        flags.append({"kind": kind, "level": level, "message": message})
        reasons.append(message)

    conflicts = sorted(set(files) & conflict_files)
    if conflicts:
        flag(
            "conflict",
            "danger",
            "Git can't combine this automatically with your own changes in "
            f"{_short_list(conflicts)} — someone has to pick which version "
            "to keep, line by line.",
        )

    overlap = sorted((set(files) & fork_files) - set(conflicts))
    if overlap:
        flag(
            "customized",
            "warning",
            f"Touches files you customized ({_short_list(overlap)}). It may "
            "merge cleanly, but check your custom behaviour still works.",
        )

    deps = [f for f in files if _is_dep_file(f)]
    if deps:
        flag(
            "dependencies",
            "warning",
            "Adds or changes the libraries the app is built on "
            f"({_short_list(deps)}). After merging you must reinstall "
            "(uv sync / npm install), and new library versions can break things.",
        )

    config_changes = [f for f in files if f in _CONFIG_FILES]
    if config_changes:
        removed: List[str] = []
        for f in config_changes:
            removed += removed_config_fields(
                raw.added.get(f, []), raw.removed.get(f, [])
            )
        used = {
            name: user_config_keys[name] for name in removed if name in user_config_keys
        }
        if used:
            paths = sorted({p for ps in used.values() for p in ps})
            flag(
                "config",
                "danger",
                "Removes or renames settings your config.toml uses "
                f"({_short_list(paths)}). Jarvis may silently ignore or reject "
                "those settings after the update.",
            )
        else:
            flag(
                "config",
                "warning",
                "Changes how settings are defined (core/config.py). Your "
                "config.toml probably still works, but check settings after updating.",
            )

    speech = [f for f in files if f.startswith(_SPEECH_PREFIXES) or f in _SPEECH_FILES]
    if speech:
        flag(
            "speech",
            "warning",
            "Touches the voice/speech system, where your fork added the "
            "Chatterbox voice. After merging, check Chatterbox still appears "
            "and speaks.",
        )

    desktop = [f for f in files if _DESKTOP_PERMISSION_RE.search(f)]
    if desktop:
        flag(
            "desktop-permissions",
            "warning",
            "Changes desktop app permissions/settings "
            f"({_short_list(desktop)}). Your fork added microphone access "
            "there — make sure it's still allowed after merging.",
        )

    analytics_files = [
        f for f in files if _ANALYTICS_PATH_RE.search(f) and _is_shipped_file(f)
    ]
    tracker_hits: List[str] = []
    network_hits: List[str] = []
    for f, lines in raw.added.items():
        if not _is_scannable_code(f):
            continue
        for ln in lines:
            if _TRACKER_RE.search(ln):
                tracker_hits.append(f)
                break
        for ln in lines:
            if _NETWORK_RE.search(ln) and not _LOCAL_HOST_RE.search(ln):
                network_hits.append(f)
                break
    if tracker_hits or analytics_files:
        where = sorted(set(tracker_hits) | set(analytics_files))
        flag(
            "privacy",
            "danger",
            "PRIVACY WARNING: changes analytics/telemetry or adds a tracking "
            f"service ({_short_list(where)}). Read this one carefully — it "
            "could send information about you off your Mac.",
        )
    if network_hits:
        flag(
            "network",
            "danger",
            "NETWORK WARNING: adds code that talks to the internet "
            f"({_short_list(sorted(set(network_hits)))}). Make sure you're "
            "okay with what it connects to before merging.",
        )

    group = classify_group(raw.subject)
    if group == "security":
        reasons.append("Security-related change — usually worth taking soon.")

    if conflicts:
        verdict = VERDICT_CONFLICT
    elif flags:
        verdict = VERDICT_REVIEW
    else:
        verdict = VERDICT_SAFE
        reasons.append(
            "Doesn't touch anything your fork customized; should merge cleanly."
        )

    body_summary = " ".join(
        ln.strip()
        for ln in raw.body.splitlines()
        if ln.strip() and not ln.lower().startswith(("co-authored-by", "signed-off-by"))
    )
    if len(body_summary) > 400:
        body_summary = body_summary[:397].rstrip() + "..."

    return {
        "sha": raw.sha,
        "short_sha": raw.sha[:8],
        "author": raw.author,
        "date": raw.date,
        "subject": raw.subject,
        "body": body_summary,
        "group": group,
        "files": files,
        "verdict": verdict,
        "reasons": reasons,
        "flags": flags,
        "conflict_files": conflicts,
    }


# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------


def _apply_steps(
    repo: Path, branch: str, upstream_ref: str, remote: str
) -> List[Dict[str, str]]:
    stamp = _dt.date.today().strftime("%Y%m%d")
    test_branch = f"upstream-merge-{stamp}"
    home = branch or "filo-main"
    return [
        {"title": "Go to your OpenJarvis source folder", "command": f'cd "{repo}"'},
        {
            "title": "Make sure you have no unsaved changes "
            "(should say 'nothing to commit')",
            "command": "git status",
        },
        {
            "title": "Download the latest upstream code (does not change anything yet)",
            "command": f"git fetch {remote}",
        },
        {
            "title": "Make a throw-away test branch",
            "command": f"git checkout -b {test_branch} {home}",
        },
        {
            "title": "Try the merge on the test branch",
            "command": f"git merge --no-ff {upstream_ref}",
        },
        {
            "title": "If it reports conflicts and you want to give up, undo the merge",
            "command": "git merge --abort",
        },
        {"title": "Reinstall dependencies", "command": "uv sync --inexact"},
        {
            "title": "Run the Python tests",
            "command": "PYTHONPATH=src .venv/bin/python -m pytest tests -q "
            "-p no:cacheprovider",
        },
        {
            "title": "Build the app UI",
            "command": "cd frontend && npm install && npm run build && cd ..",
        },
        {
            "title": "Happy? Move your main branch to the tested merge",
            "command": f"git checkout {home} && git merge --ff-only {test_branch}",
        },
        {
            "title": "Back it up to your fork on GitHub",
            "command": f"git push origin {home}",
        },
        {
            "title": "Not happy? Throw the test branch away",
            "command": f"git checkout {home} && git branch -D {test_branch}",
        },
    ]


def _empty_report(status: str, message: str, **extra: Any) -> Dict[str, Any]:
    report: Dict[str, Any] = {
        "status": status,
        "message": message,
        "checked_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "verdict": None,
        "summary": message,
        "commits": [],
        "groups": {},
        "counts": {VERDICT_SAFE: 0, VERDICT_REVIEW: 0, VERDICT_CONFLICT: 0},
        "pending": 0,
        "conflict_files": [],
        "overlap_files": [],
        "upstream_files": [],
        "fork_files": [],
        "apply_steps": [],
    }
    report.update(extra)
    return report


def _resolve_repo(repo_root: Optional[Path]) -> Optional[Path]:
    start = Path(repo_root) if repo_root is not None else find_repo_root()
    if start is None:
        return None
    try:
        out = _git(start, "rev-parse", "--show-toplevel").stdout.strip()
    except (GitError, OSError):
        return None
    return Path(out) if out else None


def _fetched_at(repo: Path) -> Optional[str]:
    try:
        gitdir = _git(repo, "rev-parse", "--git-common-dir").stdout.strip()
        fetch_head = (repo / gitdir) / "FETCH_HEAD"
        ts = fetch_head.stat().st_mtime
    except Exception:
        return None
    return _dt.datetime.fromtimestamp(ts, _dt.timezone.utc).isoformat()


def build_report(
    repo_root: Optional[Path] = None,
    *,
    refresh: bool = False,
    remote: str = "upstream",
    upstream_branch: str = "main",
    config_path: Optional[Path] = None,
    max_commits: int = MAX_COMMITS,
) -> Dict[str, Any]:
    """Build the fork update report. Never raises for expected git problems."""
    repo = _resolve_repo(repo_root)
    if repo is None:
        return _empty_report(
            "not_git",
            "OpenJarvis isn't running from a git checkout, so there's no fork "
            "to compare against upstream.",
        )

    fork = detect_fork(repo)
    upstream_ref = f"{remote}/{upstream_branch}"
    base_extra: Dict[str, Any] = {
        "repo_root": str(repo),
        "is_fork": fork.is_fork,
        "fork_reasons": fork.reasons,
        "branch": fork.branch,
        "origin_url": fork.origin_url,
        "upstream_ref": upstream_ref,
    }

    remotes = _lines(_git(repo, "remote", check=False).stdout)
    if remote not in remotes:
        return _empty_report(
            "no_upstream",
            f"No '{remote}' remote is configured. Add it once with: "
            f"git remote add {remote} {UPSTREAM_URL}",
            **base_extra,
        )

    fetch_error: Optional[str] = None
    fetched = False
    if refresh:
        try:
            _git(
                repo,
                "fetch",
                "--quiet",
                "--no-tags",
                remote,
                f"+refs/heads/{upstream_branch}:refs/remotes/{remote}/{upstream_branch}",
                timeout=FETCH_TIMEOUT_S,
            )
            fetched = True
        except GitError as exc:
            fetch_error = str(exc)

    try:
        head = _git(repo, "rev-parse", "HEAD").stdout.strip()
        upstream_sha = _git(
            repo, "rev-parse", "--verify", "--quiet", f"{upstream_ref}^{{commit}}"
        ).stdout.strip()
    except GitError:
        return _empty_report(
            "no_upstream",
            f"Haven't downloaded {upstream_ref} yet — click Check now "
            "(or run `jarvis fork-updates`).",
            fetch_error=fetch_error,
            **base_extra,
        )

    try:
        merge_base = _git(repo, "merge-base", "HEAD", upstream_ref).stdout.strip()
    except GitError:
        return _empty_report(
            "error",
            "Your branch and upstream share no history, so they can't be compared.",
            fetch_error=fetch_error,
            **base_extra,
        )

    pending_total = int(
        _git(repo, "rev-list", "--count", f"HEAD..{upstream_ref}").stdout.strip() or 0
    )
    fork_ahead = int(
        _git(repo, "rev-list", "--count", f"{upstream_ref}..HEAD").stdout.strip() or 0
    )

    fork_files = set(
        _lines(_git(repo, "diff", "--name-only", merge_base, "HEAD").stdout)
    )
    upstream_files = set(
        _lines(_git(repo, "diff", "--name-only", merge_base, upstream_ref).stdout)
    )
    overlap = sorted(fork_files & upstream_files)

    conflict_files: List[str] = []
    conflict_method = ""
    conflict_error: Optional[str] = None
    if pending_total:
        try:
            conflict_files, conflict_method = predict_conflicts(
                repo, "HEAD", upstream_ref, merge_base
            )
        except GitError as exc:
            conflict_error = str(exc)

    raw_commits: List[_RawCommit] = []
    if pending_total:
        log = _git(
            repo,
            "log",
            "--no-merges",
            "--no-color",
            "--no-ext-diff",
            "-p",
            "-U0",
            f"--max-count={max_commits}",
            f"--format={_COMMIT_MARK}%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1d",
            f"HEAD..{upstream_ref}",
        ).stdout
        raw_commits = _parse_log(log)

    user_keys = load_user_config_keys(config_path)
    conflict_set = set(conflict_files)
    commits = [
        analyze_commit(
            rc,
            fork_files=fork_files,
            conflict_files=conflict_set,
            user_config_keys=user_keys,
        )
        for rc in raw_commits
    ]

    # Conflicting files touched only by merge commits still need surfacing.
    attributed = {f for c in commits for f in c["conflict_files"]}
    unattributed = sorted(conflict_set - attributed)

    counts = {VERDICT_SAFE: 0, VERDICT_REVIEW: 0, VERDICT_CONFLICT: 0}
    groups: Dict[str, List[str]] = {g: [] for g in GROUP_ORDER}
    for c in commits:
        counts[c["verdict"]] += 1
        groups[c["group"]].append(c["sha"])
    groups = {g: v for g, v in groups.items() if v}

    if pending_total == 0:
        verdict: Optional[str] = VERDICT_SAFE
        summary = "You're up to date — upstream has nothing you don't already have."
    else:
        worst = max(
            (c["verdict"] for c in commits),
            key=lambda v: _VERDICT_RANK[v],
            default=VERDICT_SAFE,
        )
        if conflict_files:
            worst = VERDICT_CONFLICT
        verdict = worst
        plural = "s" if pending_total != 1 else ""
        pieces = [f"{pending_total} upstream commit{plural} you don't have yet."]
        if conflict_files:
            pieces.append(
                f"Merging will conflict in {len(conflict_files)} file"
                f"{'s' if len(conflict_files) != 1 else ''} you changed "
                f"({_short_list(conflict_files)}) — needs hands-on fixing."
            )
        elif overlap:
            pieces.append(
                f"It changes {len(overlap)} file{'s' if len(overlap) != 1 else ''} "
                "you customized, but git expects to merge them cleanly."
            )
        else:
            pieces.append("None of it overlaps with your customizations.")
        privacy = sum(
            1
            for c in commits
            if any(f["kind"] in ("privacy", "network") for f in c["flags"])
        )
        if privacy:
            pieces.append(
                f"⚠ {privacy} commit{'s' if privacy != 1 else ''} touch analytics "
                "or add internet access — read those first."
            )
        summary = " ".join(pieces)

    if fetch_error:
        summary += (
            f" (Couldn't reach GitHub just now: {fetch_error}. "
            "Showing the last download.)"
        )

    try:
        upstream_date = _git(
            repo, "log", "-1", "--format=%aI", upstream_ref
        ).stdout.strip()
    except GitError:
        upstream_date = ""

    return {
        "status": "ok",
        "message": "",
        "checked_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "fetched": fetched,
        "fetched_at": _fetched_at(repo),
        "fetch_error": fetch_error,
        **base_extra,
        "head": head,
        "upstream_sha": upstream_sha,
        "upstream_date": upstream_date,
        "merge_base": merge_base,
        "pending": pending_total,
        "fork_ahead": fork_ahead,
        "truncated": pending_total > len(commits) and len(commits) >= max_commits,
        "verdict": verdict,
        "summary": summary,
        "counts": counts,
        "groups": groups,
        "commits": commits,
        "conflict_files": conflict_files,
        "conflict_method": conflict_method,
        "conflict_error": conflict_error,
        "unattributed_conflict_files": unattributed,
        "overlap_files": overlap,
        "upstream_files": sorted(upstream_files),
        "fork_files": sorted(fork_files),
        "apply_steps": _apply_steps(repo, fork.branch, upstream_ref, remote)
        if pending_total
        else [],
    }


# ---------------------------------------------------------------------------
# text rendering (CLI)
# ---------------------------------------------------------------------------

_GROUP_TITLES = {
    "security": "Security",
    "features": "New features",
    "fixes": "Fixes",
    "docs": "Docs",
    "chore": "Maintenance",
    "other": "Other",
}


def render_text(report: Dict[str, Any], *, verbose: bool = False) -> str:
    out: List[str] = []
    out.append("OpenJarvis fork update report")
    out.append("=" * 30)
    if report.get("repo_root"):
        out.append(
            f"Repo:     {report['repo_root']} (branch {report.get('branch') or '?'})"
        )
    if report.get("upstream_ref"):
        out.append(f"Upstream: {report['upstream_ref']}")
    if report.get("fetched_at"):
        out.append(f"Last downloaded from GitHub: {report['fetched_at']}")
    if report["status"] != "ok":
        out.append("")
        out.append(report["message"])
        return "\n".join(out)

    out.append("")
    verdict = (report.get("verdict") or "").upper()
    out.append(f"Verdict: {verdict}")
    out.append(report["summary"])
    if report["pending"]:
        c = report["counts"]
        out.append(
            f"  safe: {c[VERDICT_SAFE]}   review: {c[VERDICT_REVIEW]}   "
            f"will conflict: {c[VERDICT_CONFLICT]}"
        )
    if report.get("conflict_files"):
        out.append("")
        out.append("Files that will conflict:")
        out += [f"  ! {f}" for f in report["conflict_files"]]
    if report.get("overlap_files"):
        out.append("")
        out.append("Upstream changes files you customized:")
        out += [f"  * {f}" for f in report["overlap_files"]]

    by_sha = {c["sha"]: c for c in report["commits"]}
    for group, shas in report.get("groups", {}).items():
        out.append("")
        out.append(f"{_GROUP_TITLES.get(group, group)} ({len(shas)})")
        for sha in shas:
            c = by_sha[sha]
            out.append(
                f"  [{c['verdict']}] {c['short_sha']} {c['subject']} "
                f"— {c['author']}, {c['date'][:10]}"
            )
            if c["verdict"] != VERDICT_SAFE or verbose:
                for reason in c["reasons"]:
                    out.append(f"      - {reason}")
            if verbose and c["body"]:
                out.append(f"      {c['body']}")
    if report.get("truncated"):
        out.append("")
        out.append(f"(Only the newest {len(report['commits'])} commits are listed.)")

    if report.get("apply_steps"):
        out.append("")
        out.append("Nothing was merged. To apply the update yourself:")
        for i, step in enumerate(report["apply_steps"], 1):
            out.append(f"  {i:>2}. {step['title']}")
            out.append(f"      {step['command']}")
    return "\n".join(out)
