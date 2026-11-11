"""Tests for the fork update report, fork detection and self-update guard.

Builds real throw-away git repos in ``tmp_path``: an "upstream" repo and a
"fork" clone of it (remote ``upstream`` = the local upstream path, so the
fetch never touches the network).
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest
from click.testing import CliRunner

from openjarvis.cli._install_detect import InstallInfo
from openjarvis.fork import detect as fork_detect
from openjarvis.fork import updates as fu

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git required")

CONFIG_PY = """\
from dataclasses import dataclass


@dataclass
class SpeechConfig:
    tts_backend: str = "kokoro"
    old_voice_key: str = "af"
    speed: float = 1.0
"""


def _git(cwd: Path, *args: str) -> str:
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "Test",
        "GIT_AUTHOR_EMAIL": "t@example.com",
        "GIT_COMMITTER_NAME": "Test",
        "GIT_COMMITTER_EMAIL": "t@example.com",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
    }
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, check=True, capture_output=True, text=True
    ).stdout


def _write(repo: Path, rel: str, text: str) -> None:
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def _commit(repo: Path, message: str, files: dict[str, str | None]) -> None:
    for rel, text in files.items():
        if text is None:
            _git(repo, "rm", "-q", rel)
        else:
            _write(repo, rel, text)
            _git(repo, "add", rel)
    _git(repo, "commit", "-q", "-m", message)


@pytest.fixture()
def repos(tmp_path: Path) -> tuple[Path, Path]:
    upstream = tmp_path / "upstream"
    upstream.mkdir()
    _git(upstream, "init", "-q", "-b", "main")
    _commit(
        upstream,
        "initial",
        {
            "README.md": "hello\n",
            "shared.txt": "line one\nline two\n",
            "notes.txt": "a\nb\nc\n",
            "pyproject.toml": '[project]\nname = "x"\ndependencies = []\n',
            "src/openjarvis/core/config.py": CONFIG_PY,
        },
    )

    fork = tmp_path / "fork"
    _git(tmp_path, "clone", "-q", str(upstream), str(fork))
    _git(fork, "remote", "rename", "origin", "upstream")
    _git(fork, "checkout", "-q", "-b", "filo-main")
    _commit(
        fork,
        "feat: fork customizations",
        {
            "shared.txt": "FORK line one\nline two\n",
            "notes.txt": "a\nb\nc\nfork note\n",
            "src/openjarvis/speech/chatterbox_tts.py": "# fork voice\n",
        },
    )

    # Upstream moves on after the fork point.
    _commit(upstream, "feat: add brand new file", {"new_feature.txt": "new\n"})
    _commit(
        upstream,
        "fix: reword shared line",
        {"shared.txt": "UPSTREAM line one\nline two\n"},
    )
    _commit(
        upstream,
        "docs: tweak notes header",
        {"notes.txt": "A\nb\nc\n"},
    )
    _commit(
        upstream,
        "chore(deps): bump deps",
        {"pyproject.toml": '[project]\nname = "x"\ndependencies = ["numpy"]\n'},
    )
    _commit(
        upstream,
        "refactor: drop old voice key",
        {
            "src/openjarvis/core/config.py": CONFIG_PY.replace(
                '    old_voice_key: str = "af"\n', ""
            )
        },
    )
    _commit(
        upstream,
        "feat: usage reporting",
        {
            "src/openjarvis/reporting.py": (
                "import requests\n\n"
                "def send(data):\n"
                "    requests.post('https://collector.example.com/v1', json=data)\n"
            )
        },
    )
    _commit(
        upstream,
        "fix(security): sanitize tool output",
        {"src/openjarvis/sanitize.py": "def clean(s):\n    return s.strip()\n"},
    )
    return upstream, fork


@pytest.fixture()
def user_config(tmp_path: Path) -> Path:
    cfg = tmp_path / "config.toml"
    cfg.write_text('[speech]\ntts_backend = "chatterbox"\nold_voice_key = "bf"\n')
    return cfg


def _by_subject(report: dict) -> dict[str, dict]:
    return {c["subject"]: c for c in report["commits"]}


def test_report_flags_conflicts_and_risks(repos, user_config):
    _, fork = repos
    head_before = _git(fork, "rev-parse", "HEAD")

    report = fu.build_report(fork, refresh=True, config_path=user_config)

    assert report["status"] == "ok"
    assert report["fetched"] is True
    assert report["pending"] == 7
    assert report["fork_ahead"] == 1
    assert report["verdict"] == fu.VERDICT_CONFLICT
    assert report["conflict_files"] == ["shared.txt"]
    assert set(report["overlap_files"]) == {"shared.txt", "notes.txt"}
    assert "src/openjarvis/speech/chatterbox_tts.py" in report["fork_files"]

    c = _by_subject(report)
    assert c["feat: add brand new file"]["verdict"] == fu.VERDICT_SAFE
    assert c["fix: reword shared line"]["verdict"] == fu.VERDICT_CONFLICT
    assert c["fix: reword shared line"]["conflict_files"] == ["shared.txt"]

    notes = c["docs: tweak notes header"]
    assert notes["verdict"] == fu.VERDICT_REVIEW
    assert {f["kind"] for f in notes["flags"]} == {"customized"}

    deps = c["chore(deps): bump deps"]
    assert deps["verdict"] == fu.VERDICT_REVIEW
    assert any(f["kind"] == "dependencies" for f in deps["flags"])

    cfg = c["refactor: drop old voice key"]
    cfg_flag = next(f for f in cfg["flags"] if f["kind"] == "config")
    assert cfg_flag["level"] == "danger"
    assert "speech.old_voice_key" in cfg_flag["message"]

    net = c["feat: usage reporting"]
    assert any(f["kind"] == "network" for f in net["flags"])
    assert net["verdict"] == fu.VERDICT_REVIEW

    sec = c["fix(security): sanitize tool output"]
    assert sec["group"] == "security"
    assert sec["verdict"] == fu.VERDICT_SAFE

    assert report["groups"]["features"]
    assert report["groups"]["fixes"]
    assert report["groups"]["docs"]
    assert report["groups"]["chore"]
    assert report["counts"] == {"safe": 2, "review": 4, "will conflict": 1}
    assert "NETWORK WARNING" in " ".join(net["reasons"])
    assert any(
        "git merge --no-ff upstream/main" in s["command"] for s in report["apply_steps"]
    )

    # Nothing about the checkout changed.
    assert _git(fork, "rev-parse", "HEAD") == head_before
    assert _git(fork, "status", "--porcelain") == ""
    assert _git(fork, "rev-parse", "--abbrev-ref", "HEAD").strip() == "filo-main"
    assert (fork / "shared.txt").read_text() == "FORK line one\nline two\n"

    text = fu.render_text(report)
    assert "Verdict: WILL CONFLICT" in text
    assert "! shared.txt" in text


def test_no_refresh_does_not_fetch(repos, user_config):
    _, fork = repos
    report = fu.build_report(fork, refresh=False, config_path=user_config)
    # The clone happened before upstream moved on, and we didn't fetch.
    assert report["status"] == "ok"
    assert report["fetched"] is False
    assert report["pending"] == 0
    assert report["verdict"] == fu.VERDICT_SAFE
    assert "up to date" in report["summary"]


def test_clean_update_is_safe(tmp_path):
    upstream = tmp_path / "up"
    upstream.mkdir()
    _git(upstream, "init", "-q", "-b", "main")
    _commit(upstream, "init", {"a.txt": "a\n"})
    fork = tmp_path / "fk"
    _git(tmp_path, "clone", "-q", str(upstream), str(fork))
    _git(fork, "remote", "rename", "origin", "upstream")
    _commit(fork, "feat: mine", {"mine.txt": "m\n"})
    _commit(upstream, "feat: theirs", {"theirs.txt": "t\n"})

    report = fu.build_report(fork, refresh=True, config_path=tmp_path / "none.toml")
    assert report["verdict"] == fu.VERDICT_SAFE
    assert report["conflict_files"] == []
    assert report["overlap_files"] == []
    assert report["commits"][0]["verdict"] == fu.VERDICT_SAFE


def test_legacy_merge_tree_fallback(repos, monkeypatch):
    _, fork = repos
    _git(fork, "fetch", "-q", "upstream")
    monkeypatch.setattr(fu, "git_version", lambda repo: (2, 30, 0))
    files, method = fu.predict_conflicts(fork, "HEAD", "upstream/main")
    assert method == "merge-tree (legacy)"
    assert files == ["shared.txt"]


def test_parse_legacy_merge_tree_sample():
    sample = (
        "changed in both\n"
        "  base   100644 aaaaaaaa shared.txt\n"
        "  our    100644 bbbbbbbb shared.txt\n"
        "  their  100644 cccccccc shared.txt\n"
        "@@ -1,2 +1,6 @@\n"
        "+<<<<<<< .our\n"
        " FORK line one\n"
        "+=======\n"
        "+UPSTREAM line one\n"
        "+>>>>>>> .their\n"
        "changed in both\n"
        "  base   100644 dddddddd notes.txt\n"
        "  our    100644 eeeeeeee notes.txt\n"
        "  their  100644 ffffffff notes.txt\n"
        "@@ -1,3 +1,4 @@\n"
        "-a\n"
        "+A\n"
    )
    assert fu.parse_legacy_merge_tree(sample) == ["shared.txt"]


def test_not_a_git_checkout(tmp_path):
    report = fu.build_report(tmp_path)
    assert report["status"] == "not_git"
    assert report["commits"] == []


def test_missing_upstream_remote(tmp_path):
    repo = tmp_path / "solo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _commit(repo, "init", {"a.txt": "a\n"})
    report = fu.build_report(repo, refresh=True)
    assert report["status"] == "no_upstream"
    assert "git remote add upstream" in report["message"]


@pytest.mark.parametrize(
    "subject,group",
    [
        ("feat(ui): new page", "features"),
        ("fix: crash", "fixes"),
        ("docs: readme", "docs"),
        ("chore: update clone traffic data [skip ci]", "chore"),
        ("ci: speed up", "chore"),
        ("fix: patch CVE-2026-1234 in parser", "security"),
        ("security: tighten sandbox", "security"),
        ("Merge pull request #1", "other"),
    ],
)
def test_classify_group(subject, group):
    assert fu.classify_group(subject) == group


def test_removed_config_fields_ignores_moves():
    removed = ['    old_key: str = "x"', "    speed: float = 1.0"]
    added = ["    speed: float = 1.5"]
    assert fu.removed_config_fields(added, removed) == ["old_key"]


# ---------------------------------------------------------------------------
# fork detection
# ---------------------------------------------------------------------------


def test_detect_fork_by_marker_origin_and_branch(repos, monkeypatch):
    upstream, fork = repos
    monkeypatch.delenv("OPENJARVIS_FORK", raising=False)

    info = fork_detect.detect_fork(fork)
    assert info.is_fork  # on branch filo-main
    assert info.branch == "filo-main"

    assert not fork_detect.detect_fork(upstream).is_fork

    _git(
        upstream,
        "remote",
        "add",
        "origin",
        "git@github.com:Filobatire-Henein/OpenJarvis.git",
    )
    assert fork_detect.detect_fork(upstream).is_fork
    _git(upstream, "remote", "remove", "origin")

    (upstream / fork_detect.FORK_MARKER).write_text("fork\n")
    assert fork_detect.detect_fork(upstream).is_fork

    monkeypatch.setenv("OPENJARVIS_FORK", "0")
    assert not fork_detect.detect_fork(upstream).is_fork


def test_detect_fork_without_search_only_uses_env(monkeypatch):
    monkeypatch.delenv("OPENJARVIS_FORK", raising=False)
    assert not fork_detect.detect_fork(None, search=False).is_fork
    monkeypatch.setenv("OPENJARVIS_FORK", "1")
    assert fork_detect.detect_fork(None, search=False).is_fork


# ---------------------------------------------------------------------------
# auto-update guards
# ---------------------------------------------------------------------------


def test_self_update_refuses_on_fork(repos, monkeypatch):
    from openjarvis.cli.self_update_cmd import self_update

    _, fork = repos
    monkeypatch.delenv("OPENJARVIS_FORK", raising=False)
    info = InstallInfo(
        kind="editable-git", upgrade_command="jarvis self-update", repo_root=fork
    )
    with (
        patch("openjarvis.cli.self_update_cmd.detect_install", return_value=info),
        patch("openjarvis.cli.self_update_cmd.subprocess.run") as mock_run,
    ):
        result = CliRunner().invoke(self_update, ["--yes"])
    mock_run.assert_not_called()
    assert result.exit_code == 2
    assert "This is the Filo fork" in result.output
    assert "jarvis fork-updates" in result.output


def test_self_update_refuses_pypi_reinstall_when_fork_env(monkeypatch):
    from openjarvis.cli.self_update_cmd import self_update

    monkeypatch.setenv("OPENJARVIS_FORK", "1")
    info = InstallInfo(kind="pypi", upgrade_command="pip install --upgrade openjarvis")
    with (
        patch("openjarvis.cli.self_update_cmd.detect_install", return_value=info),
        patch("openjarvis.cli.self_update_cmd.subprocess.run") as mock_run,
    ):
        result = CliRunner().invoke(self_update, ["--check"])
    mock_run.assert_not_called()
    assert result.exit_code == 0
    assert "This is the Filo fork" in result.output


def test_self_update_upstream_behaviour_kept_for_non_fork(tmp_path, monkeypatch):
    from openjarvis.cli.self_update_cmd import self_update

    monkeypatch.delenv("OPENJARVIS_FORK", raising=False)
    info = InstallInfo(kind="pypi", upgrade_command="pip install --upgrade openjarvis")
    with patch("openjarvis.cli.self_update_cmd.detect_install", return_value=info):
        result = CliRunner().invoke(self_update, ["--check"])
    assert result.exit_code == 0
    assert "pip install --upgrade openjarvis" in result.output
    assert "Filo fork" not in result.output


def test_version_banner_disabled_on_fork(monkeypatch, tmp_path):
    from openjarvis.cli import _version_check

    for v in ("OPENJARVIS_NO_UPDATE_CHECK", "CI"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setenv("OPENJARVIS_CONFIG", str(tmp_path / "none.toml"))
    monkeypatch.setenv("OPENJARVIS_FORK", "1")
    assert _version_check._check_disabled() is True
    with patch.object(_version_check, "_do_check") as do_check:
        _version_check.check_for_updates("chat")
    do_check.assert_not_called()

    monkeypatch.setenv("OPENJARVIS_FORK", "0")
    assert _version_check._check_disabled() is False


def test_fork_updates_route(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from openjarvis.server import fork_routes

    calls = []

    def fake_build_report(**kwargs):
        calls.append(kwargs)
        return {"status": "ok", "pending": 0, "commits": []}

    monkeypatch.setattr(fu, "build_report", fake_build_report)
    app = FastAPI()
    app.include_router(fork_routes.router)
    client = TestClient(app)
    assert client.get("/v1/fork/updates").json()["status"] == "ok"
    client.get("/v1/fork/updates?refresh=1")
    assert calls == [{"refresh": False}, {"refresh": True}]


def test_fork_updates_cli(repos, user_config, monkeypatch):
    from openjarvis.cli.fork_updates_cmd import fork_updates

    _, fork = repos
    monkeypatch.setenv("OPENJARVIS_CONFIG", str(user_config))
    result = CliRunner().invoke(fork_updates, ["--repo", str(fork)])
    assert result.exit_code == 0, result.output
    assert "WILL CONFLICT" in result.output
    assert "Nothing was merged" in result.output
