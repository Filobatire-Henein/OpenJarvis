"""Tests for macOS computer control — every subprocess/osascript is mocked.

Nothing here clicks, types, opens or quits anything on the real machine.
"""

from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path
from typing import Any, List, Optional, Sequence

import pytest

from openjarvis.core.config import JarvisConfig, MacControlConfig
from openjarvis.security import untrusted_context
from openjarvis.tools import mac_control as mc
from openjarvis.tools.approval_store import (
    STATUS_APPROVED,
    STATUS_DENIED,
    STATUS_EXECUTED,
    STATUS_EXPIRED,
    ApprovalStore,
)

APPS = {
    "safari": ("Safari", "/Applications/Safari.app"),
    "notes": ("Notes", "/System/Applications/Notes.app"),
    "google chrome": ("Google Chrome", "/Applications/Google Chrome.app"),
    "chromium": ("Chromium", "/Applications/Chromium.app"),
    "calculator": ("Calculator", "/System/Applications/Calculator.app"),
}


class FakeRunner:
    """Records argv lists; answers osascript queries with canned output."""

    def __init__(self, front: str = "Safari\nApple", running: str = "Finder, Safari"):
        self.calls: List[List[str]] = []
        self.front = front
        self.running = running
        self.fail_with: Optional[str] = None
        self.stdout_for: dict = {}

    def __call__(self, cmd: Sequence[str], timeout: float):
        cmd = list(cmd)
        self.calls.append(cmd)
        script = " ".join(cmd)
        out = ""
        if cmd[0] == "osascript":
            if "frontmost is true" in script:
                out = self.front
            elif "background only is false" in script:
                out = self.running
            elif "entire contents" in script:
                out = "clicked"
            if self.fail_with and "frontmost is true" not in script:
                return subprocess.CompletedProcess(cmd, 1, "", self.fail_with)
        for key, value in self.stdout_for.items():
            if cmd[: len(key)] == list(key):
                out = value
        return subprocess.CompletedProcess(cmd, 0, out, "")

    def action_calls(self) -> List[List[str]]:
        """Calls other than the read-only frontmost/running queries."""
        return [
            c
            for c in self.calls
            if not any(
                "frontmost is true" in part or "background only is false" in part
                for part in c
            )
        ]


def _is_keystroke(cmd: List[str]) -> bool:
    return any("keystroke (item 1 of argv)" in part for part in cmd)


class FakeQuartz:
    def __init__(self):
        self.events: List[tuple] = []

    def click(self, x, y, count=1):
        self.events.append(("click", x, y, count))

    def move(self, x, y):
        self.events.append(("move", x, y))

    def scroll(self, dy, dx=0):
        self.events.append(("scroll", dy, dx))


def make_controller(
    tmp_path: Path,
    *,
    enabled: bool = True,
    runner: Optional[FakeRunner] = None,
    clock=None,
    sleep=None,
    ax: Optional[bool] = True,
    screen: Optional[bool] = True,
    windows: Optional[list] = None,
    **cfg_overrides: Any,
) -> mc.MacController:
    cfg = MacControlConfig(enabled=enabled, **cfg_overrides)
    kwargs: dict = {}
    if clock is not None:
        kwargs["clock"] = clock
    if sleep is not None:
        kwargs["sleep"] = sleep
    ctl = mc.MacController(
        settings_loader=lambda: (cfg, "http://127.0.0.1:11434", "qwen3.5:9b"),
        runner=runner or FakeRunner(),
        store=ApprovalStore(str(tmp_path / "approvals.db")),
        quartz=FakeQuartz(),
        platform="darwin",
        stop_file=tmp_path / "mac_control.stopped",
        ax_checker=lambda: ax,
        screen_checker=lambda: screen,
        installed_apps=lambda: dict(APPS),
        window_lister=lambda: list(windows or []),
        **kwargs,
    )
    ctl.POLL_INTERVAL_S = 0.01
    return ctl


def approve_when_pending(store: ApprovalStore, decision: str = STATUS_APPROVED):
    """Background 'user' that answers the first pending approval."""
    seen: dict = {}

    def run():
        deadline = time.time() + 5
        while time.time() < deadline:
            pending = store.list_pending()
            if pending:
                seen["action"] = pending[0]
                store.update_status(pending[0].id, decision)
                return
            time.sleep(0.01)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t, seen


@pytest.fixture(autouse=True)
def _reset_untrusted():
    untrusted_context.clear()
    yield
    untrusted_context.clear()
    mc.set_controller(None)


# ---------------------------------------------------------------------------
# Risk classification
# ---------------------------------------------------------------------------


def test_risk_classification():
    safe = {
        "mac_open_app",
        "mac_list_apps",
        "mac_frontmost",
        "mac_search",
        "mac_open_url",
        "mac_screenshot_describe",
        "mac_move_mouse",
        "mac_browser_tabs",
    }
    risky = {
        "mac_type_text",
        "mac_press_keys",
        "mac_click",
        "mac_scroll",
        "mac_quit_app",
        "mac_run_shortcut",
    }
    assert {n for n, r in mc.TOOL_RISK.items() if r == mc.RISK_SAFE} == safe
    assert {n for n, r in mc.TOOL_RISK.items() if r == mc.RISK_RISKY} == risky
    assert mc.risk_of("mac_something_new") == mc.RISK_RISKY  # fail closed


def test_no_generic_shell_tool_registered():
    assert not any("shell" in name for name in mc.TOOL_RISK)


def test_specs_label_risk_and_outlive_approval():
    ctl = mc.MacController(platform="darwin")
    for cls in mc._MacTool.__subclasses__():
        spec = cls(ctl).spec
        assert spec.metadata["risk"] == mc.risk_of(spec.name)
        assert spec.requires_confirmation is False  # gated by our own approval
        if spec.metadata["risk"] == mc.RISK_RISKY:
            assert "approve" in spec.description
            assert spec.timeout_seconds > 600


# ---------------------------------------------------------------------------
# Disabled by default / kill switch / platform
# ---------------------------------------------------------------------------


def test_config_disabled_by_default():
    cfg = JarvisConfig().mac_control
    assert cfg.enabled is False
    assert cfg.allow_safe_without_asking is True
    assert cfg.approval_timeout_s == 60
    assert cfg.max_risky_per_minute == 10


def test_config_toml_section_loads(tmp_path, monkeypatch):
    path = tmp_path / "config.toml"
    path.write_text(
        "[mac_control]\nenabled = true\napproval_timeout_s = 30\n"
        "[engine.ollama]\nhost = 'http://127.0.0.1:11434'\n"
        "[intelligence]\ndefault_model = 'qwen3.5:9b'\n"
    )
    monkeypatch.setenv("OPENJARVIS_CONFIG", str(path))
    cfg, host, model = mc._load_settings()
    assert cfg.enabled is True and cfg.approval_timeout_s == 30
    assert host == "http://127.0.0.1:11434" and model == "qwen3.5:9b"


def test_tools_refuse_when_disabled_by_default(tmp_path):
    runner = FakeRunner()
    # Real loader against the isolated (empty) test OPENJARVIS_HOME.
    ctl = mc.MacController(
        runner=runner,
        platform="darwin",
        stop_file=tmp_path / "stop",
        installed_apps=lambda: dict(APPS),
    )
    result = mc.MacOpenAppTool(ctl).execute(name="Safari")
    assert result.success is False
    assert "turned off" in result.content
    assert runner.calls == []


def test_refuses_off_macos(tmp_path):
    ctl = make_controller(tmp_path)
    ctl.platform = "linux"
    result = mc.MacOpenAppTool(ctl).execute(name="Safari")
    assert not result.success and "macOS" in result.content


def test_kill_switch_blocks_and_denies_pending(tmp_path):
    runner = FakeRunner()
    ctl = make_controller(tmp_path, runner=runner)
    ctl.stop()
    assert ctl.is_stopped()
    assert (tmp_path / "mac_control.stopped").exists()
    result = mc.MacOpenAppTool(ctl).execute(name="Safari")
    assert not result.success and "stopped" in result.content
    assert runner.calls == []
    ctl.resume()
    assert not ctl.is_stopped()
    assert mc.MacOpenAppTool(ctl).execute(name="Safari").success


def test_kill_switch_while_waiting_denies(tmp_path):
    ctl = make_controller(tmp_path, approval_timeout_s=30)
    tool = mc.MacTypeTextTool(ctl)
    out: dict = {}
    t = threading.Thread(target=lambda: out.update(r=tool.execute(text="hi")))
    t.start()
    deadline = time.time() + 5

    def pending():
        with ctl._store_lock:  # same connection as the waiting thread
            return ctl.store.list_pending()

    while not pending() and time.time() < deadline:
        time.sleep(0.01)
    assert ctl.stop() == 1
    t.join(5)
    assert out["r"].success is False
    assert "stopped" in out["r"].content


# ---------------------------------------------------------------------------
# Safe actions run without asking
# ---------------------------------------------------------------------------


def test_open_app_runs_without_approval(tmp_path):
    runner = FakeRunner()
    ctl = make_controller(tmp_path, runner=runner)
    result = mc.MacOpenAppTool(ctl).execute(name="safari.app")
    assert result.success, result.content
    assert runner.calls == [["open", "-a", "/Applications/Safari.app"]]
    assert ctl.store.list_pending() == []


def test_safe_actions_ask_when_configured(tmp_path):
    runner = FakeRunner()
    ctl = make_controller(tmp_path, runner=runner, allow_safe_without_asking=False)
    t, seen = approve_when_pending(ctl.store)
    result = mc.MacOpenAppTool(ctl).execute(name="Notes")
    t.join(5)
    assert result.success
    assert seen["action"].description == "Jarvis wants to open Notes."


@pytest.mark.parametrize(
    "name",
    [
        "/Applications/Safari.app",
        "../Safari",
        "-a Safari",
        "--args",
        "Safari\n--foo",
        "~/evil",
        "",
        "x" * 101,
        42,
        "Nonexistent App",
    ],
)
def test_open_app_rejects_injection_and_unknown(tmp_path, name):
    runner = FakeRunner()
    ctl = make_controller(tmp_path, runner=runner)
    result = mc.MacOpenAppTool(ctl).execute(name=name)
    assert result.success is False
    assert runner.calls == []


def test_resolve_app_fuzzy_and_ambiguous():
    assert mc.resolve_app("SAFARI", APPS) == APPS["safari"]
    assert mc.resolve_app("calc", APPS) == APPS["calculator"]
    with pytest.raises(ValueError, match="Several apps match"):
        mc.resolve_app("chrom", APPS)
    with pytest.raises(ValueError, match="Did you mean"):
        mc.resolve_app("Safarri", APPS)


def test_list_installed_apps_reads_bundles(tmp_path):
    (tmp_path / "Foo.app").mkdir()
    (tmp_path / "notes.txt").write_text("x")
    apps = mc.list_installed_apps([str(tmp_path)])
    assert apps["foo"] == ("Foo", str(tmp_path / "Foo.app"))
    assert "notes" not in apps


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "x-apple.systempreferences:foo",
        "https://",
        "https://exa mple.com",
        "https://example.com/\x00",
        "ftp://example.com",
        "",
    ],
)
def test_open_url_rejects_non_http(tmp_path, url):
    runner = FakeRunner()
    ctl = make_controller(tmp_path, runner=runner)
    assert mc.MacOpenUrlTool(ctl).execute(url=url).success is False
    assert runner.calls == []


def test_open_url_ok(tmp_path):
    runner = FakeRunner()
    ctl = make_controller(tmp_path, runner=runner)
    assert mc.MacOpenUrlTool(ctl).execute(url="https://example.com/a?b=1").success
    assert runner.calls == [["open", "https://example.com/a?b=1"]]


def test_web_search_opens_duckduckgo(tmp_path):
    runner = FakeRunner()
    ctl = make_controller(tmp_path, runner=runner)
    result = mc.MacSearchTool(ctl).execute(query="best pizza & beer", where="web")
    assert result.success
    assert runner.calls == [["open", "https://duckduckgo.com/?q=best+pizza+%26+beer"]]


def test_file_search_is_read_only_mdfind(tmp_path):
    runner = FakeRunner()
    hits = "\n".join(f"/Users/me/f{i}.txt" for i in range(30))
    runner.stdout_for[("mdfind",)] = hits
    ctl = make_controller(tmp_path, runner=runner)
    result = mc.MacSearchTool(ctl).execute(query="--help taxes", where="files")
    assert result.success
    cmd = runner.calls[0]
    assert cmd[:2] == ["mdfind", "-onlyin"]
    assert cmd[-1] == "help taxes"  # leading dashes stripped: never an option
    assert "/Users/me/f19.txt" in result.content
    assert "/Users/me/f20.txt" not in result.content
    assert "10 more" in result.content


def test_frontmost(tmp_path):
    runner = FakeRunner(front="Safari\nApple – Start Page")
    ctl = make_controller(tmp_path, runner=runner)
    result = mc.MacFrontmostTool(ctl).execute()
    assert result.success
    assert "Safari" in result.content and "Start Page" in result.content


def test_list_apps(tmp_path):
    ctl = make_controller(tmp_path)
    result = mc.MacListAppsTool(ctl).execute(include_installed=True)
    assert "Finder, Safari" in result.content
    assert "Installed apps:" in result.content


# ---------------------------------------------------------------------------
# Screenshot + vision
# ---------------------------------------------------------------------------


class FakeResp:
    def __init__(self, status: int, data: dict):
        self.status_code = status
        self._data = data

    def json(self):
        return self._data


class FakeHttp:
    def __init__(self, caps=("completion", "vision")):
        self.caps = list(caps)
        self.posts: List[tuple] = []

    def post(self, url, json=None):
        self.posts.append((url, json))
        if url.endswith("/api/show"):
            return FakeResp(200, {"capabilities": self.caps})
        return FakeResp(200, {"message": {"content": "A Safari window."}})


class ShotRunner(FakeRunner):
    def __call__(self, cmd, timeout):
        if cmd[0] == "screencapture":
            Path(cmd[-1]).write_bytes(b"\xff\xd8fakejpeg")
        return super().__call__(cmd, timeout)


def test_screenshot_sent_only_to_local_model_and_deleted(tmp_path):
    runner = ShotRunner()
    ctl = make_controller(tmp_path, runner=runner)
    ctl.http_client = FakeHttp()
    result = mc.MacScreenshotDescribeTool(ctl).execute(question="What is open?")
    assert result.success, result.content
    assert "A Safari window." in result.content
    assert "SCREEN CONTENT" in result.content  # labelled as untrusted data
    shot_cmd = next(c for c in runner.calls if c[0] == "screencapture")
    assert shot_cmd[:2] == ["screencapture", "-x"]
    assert not Path(shot_cmd[-1]).exists()  # deleted immediately
    assert not Path(shot_cmd[-1]).parent.exists()
    urls = [u for u, _ in ctl.http_client.posts]
    assert all(u.startswith("http://127.0.0.1:11434/") for u in urls)
    chat = next(j for u, j in ctl.http_client.posts if u.endswith("/api/chat"))
    assert chat["model"] == "qwen3.5:9b"
    assert "mac_screenshot_describe" in untrusted_context.recent_untrusted_sources()


def test_screenshot_refuses_remote_engine(tmp_path):
    runner = ShotRunner()
    ctl = make_controller(tmp_path, runner=runner)
    ctl._settings_loader = lambda: (
        MacControlConfig(enabled=True),
        "http://gpu-box.example.com:11434",
        "qwen3.5:9b",
    )
    ctl.http_client = FakeHttp()
    result = mc.MacScreenshotDescribeTool(ctl).execute()
    assert not result.success and "non-local" in result.content
    assert not any(c[0] == "screencapture" for c in runner.calls)
    assert ctl.http_client.posts == []


def test_screenshot_without_vision_model_falls_back(tmp_path):
    runner = ShotRunner()
    ctl = make_controller(tmp_path, runner=runner)
    ctl.http_client = FakeHttp(caps=("completion", "tools"))
    result = mc.MacScreenshotDescribeTool(ctl).execute()
    assert result.success
    assert "cannot read images" in result.content
    assert "qwen2.5vl" in result.content
    assert not any(c[0] == "screencapture" for c in runner.calls)


def test_screenshot_needs_screen_recording(tmp_path):
    ctl = make_controller(tmp_path, screen=False)
    result = mc.MacScreenshotDescribeTool(ctl).execute()
    assert not result.success and "Screen Recording" in result.content


# ---------------------------------------------------------------------------
# Risky actions: approval blocking / deny / timeout
# ---------------------------------------------------------------------------


def test_type_text_blocks_until_approved_then_runs(tmp_path):
    runner = FakeRunner()
    ctl = make_controller(tmp_path, runner=runner)
    t, seen = approve_when_pending(ctl.store)
    result = mc.MacTypeTextTool(ctl).execute(text="hello", app="Safari")
    t.join(5)
    assert result.success, result.content
    action = seen["action"]
    assert action.action_type == "mac_type_text"
    assert action.tier == "high"
    assert action.description.startswith("Jarvis wants to type 'hello' into Safari")
    assert ctl.store.get_action(action.id).status == STATUS_EXECUTED
    typed = [c for c in runner.action_calls() if _is_keystroke(c)]
    assert len(typed) == 1 and typed[0][-2:] == ["--", "hello"]


def test_type_text_denied_does_nothing(tmp_path):
    runner = FakeRunner()
    ctl = make_controller(tmp_path, runner=runner)
    t, _ = approve_when_pending(ctl.store, STATUS_DENIED)
    result = mc.MacTypeTextTool(ctl).execute(text="hello")
    t.join(5)
    assert result.success is False and "denied" in result.content
    assert runner.action_calls() == []


def test_approval_times_out_to_deny(tmp_path):
    now = [1000.0]
    runner = FakeRunner()
    ctl = make_controller(
        tmp_path,
        runner=runner,
        clock=lambda: now[0],
        sleep=lambda s: now.__setitem__(0, now[0] + 10),
        approval_timeout_s=60,
    )
    result = mc.MacQuitAppTool(ctl).execute(name="Safari")
    assert result.success is False
    assert "No answer within 60s" in result.content
    assert runner.action_calls() == []
    rows = ctl.store._conn.execute("SELECT status FROM pending_actions").fetchall()
    assert rows == [(STATUS_EXPIRED,)]


def test_approval_expiry_matches_timeout(tmp_path):
    ctl = make_controller(tmp_path, approval_timeout_s=60)
    t, seen = approve_when_pending(ctl.store, STATUS_DENIED)
    mc.MacTypeTextTool(ctl).execute(text="x")
    t.join(5)
    a = seen["action"]
    from datetime import datetime

    span = datetime.fromisoformat(a.expires_at) - datetime.fromisoformat(a.created_at)
    assert 59 <= span.total_seconds() <= 61
    assert a.payload["timeout_s"] == 60


def test_every_risky_call_asks_again(tmp_path):
    ctl = make_controller(tmp_path)
    for _ in range(2):
        t, seen = approve_when_pending(ctl.store)
        assert mc.MacPressKeysTool(ctl).execute(keys="cmd+t").success
        t.join(5)
        assert "action" in seen  # an approval was needed both times


def test_untrusted_content_is_flagged_in_prompt(tmp_path):
    ctl = make_controller(tmp_path)
    untrusted_context.note_tool_output("web_search", True)
    t, seen = approve_when_pending(ctl.store, STATUS_DENIED)
    mc.MacTypeTextTool(ctl).execute(text="rm -rf ~")
    t.join(5)
    a = seen["action"]
    assert "web_search" in a.description
    assert "may have been triggered by that content" in a.description
    assert a.payload["untrusted_sources"] == ["web_search"]


def test_local_tool_output_not_flagged():
    untrusted_context.note_tool_output("calculator", True)
    assert untrusted_context.recent_untrusted_sources() == []
    untrusted_context.note_tool_output("some_remote_tool", False)
    assert untrusted_context.recent_untrusted_sources() == ["some_remote_tool"]
    assert untrusted_context.recent_untrusted_sources(60, now=time.time() + 120) == []


def test_accessibility_missing_gives_help_without_prompting(tmp_path):
    runner = FakeRunner()
    ctl = make_controller(tmp_path, runner=runner, ax=False)
    result = mc.MacTypeTextTool(ctl).execute(text="hi", app="Safari")
    assert not result.success
    assert "Privacy & Security → Accessibility" in result.content
    assert ctl.store.list_pending() == []


def test_osascript_permission_errors_are_explained(tmp_path):
    assert "Accessibility" in mc.explain_osascript_error(
        "execution error: osascript is not allowed assistive access. (-1719)"
    )
    assert "Automation" in mc.explain_osascript_error(
        "Not authorized to send Apple events to System Events. (-1743)"
    )


# ---------------------------------------------------------------------------
# AppleScript injection safety
# ---------------------------------------------------------------------------

INJECTIONS = [
    '"; do shell script "rm -rf ~"; "',
    'hello" & (do shell script "id") & "',
    'line1\nend tell\ndo shell script "id"',
    "-e do shell script",
    "\\\" \\ ' `$(id)`",
]


@pytest.mark.parametrize("payload", INJECTIONS)
def test_typed_text_never_enters_script_source(tmp_path, payload):
    runner = FakeRunner()
    ctl = make_controller(tmp_path, runner=runner)
    t, _ = approve_when_pending(ctl.store)
    result = mc.MacTypeTextTool(ctl).execute(text=payload, app="Safari")
    t.join(5)
    assert result.success, result.content
    call = next(c for c in runner.action_calls() if _is_keystroke(c))
    sep = call.index("--")
    script_parts = call[:sep]
    assert call[sep + 1 :] == [payload]
    assert all(payload not in part for part in script_parts)
    assert not any("do shell script" in part for part in script_parts)


def test_osascript_argv_puts_args_after_double_dash():
    argv = mc.osascript_argv(
        ["on run argv", "return item 1 of argv", "end run"], ["-x"]
    )
    assert argv == [
        "osascript",
        "-e",
        "on run argv",
        "-e",
        "return item 1 of argv",
        "-e",
        "end run",
        "--",
        "-x",
    ]


def test_click_element_name_passed_as_argv(tmp_path):
    runner = FakeRunner()
    ctl = make_controller(tmp_path, runner=runner)
    t, seen = approve_when_pending(ctl.store)
    evil = 'Send" then do shell script "id'
    result = mc.MacClickTool(ctl).execute(element=evil, app="Safari")
    t.join(5)
    assert result.success, result.content
    call = runner.action_calls()[-1]
    assert call[-3:] == ["--", "Safari", evil]
    assert "click" in seen["action"].description


def test_click_coordinates_use_quartz(tmp_path):
    ctl = make_controller(tmp_path)
    t, seen = approve_when_pending(ctl.store)
    assert mc.MacClickTool(ctl).execute(x=100, y=200, double=True).success
    t.join(5)
    assert ctl.quartz().events == [("click", 100, 200, 2)]
    assert "(100, 200)" in seen["action"].description


@pytest.mark.parametrize(
    "params", [{"x": -1, "y": 5}, {"x": "1; rm", "y": 1}, {"x": 5}, {}]
)
def test_click_rejects_bad_params(tmp_path, params):
    ctl = make_controller(tmp_path)
    assert mc.MacClickTool(ctl).execute(**params).success is False
    assert ctl.store.list_pending() == []


def test_scroll(tmp_path):
    ctl = make_controller(tmp_path)
    t, _ = approve_when_pending(ctl.store)
    assert mc.MacScrollTool(ctl).execute(direction="down", amount=3, x=10, y=20).success
    t.join(5)
    assert ctl.quartz().events == [("move", 10, 20), ("scroll", -3, 0)]


def test_parse_key_combo():
    c = mc.parse_key_combo("cmd+shift+t")
    assert c.modifiers == ("command down", "shift down") and c.char == "t"
    assert c.label == "⌘+Shift+T"
    assert mc.parse_key_combo("Return").key_code == 36
    assert mc.parse_key_combo("cmd++").char == "+"
    for bad in ["", "cmd+", "hyper+x", "cmd+notakey", 'cmd+"', None]:
        if bad == 'cmd+"':
            # a quote is a legal single key, but it must travel via argv
            lines, args = mc.key_script(mc.parse_key_combo(bad))
            assert args == ['"'] and '"\\""' not in " ".join(lines)
            continue
        with pytest.raises(ValueError):
            mc.parse_key_combo(bad)


def test_key_script_uses_fixed_vocabulary():
    lines, args = mc.key_script(mc.parse_key_combo("ctrl+option+down"))
    assert lines == [
        'tell application "System Events" to key code 125 using '
        "{control down, option down}"
    ]
    assert args == []


def test_press_keys_description(tmp_path):
    ctl = make_controller(tmp_path)
    t, seen = approve_when_pending(ctl.store)
    assert mc.MacPressKeysTool(ctl).execute(keys="cmd+w", times=2).success
    t.join(5)
    assert seen["action"].description.startswith(
        "Jarvis wants to press ⌘+W 2 times in Safari"
    )


def test_quit_protected_and_not_running(tmp_path):
    ctl = make_controller(tmp_path)
    assert "part of macOS" in mc.MacQuitAppTool(ctl).execute(name="Dock").content
    assert "not running" in mc.MacQuitAppTool(ctl).execute(name="Notes").content
    assert ctl.store.list_pending() == []


def test_run_shortcut_must_exist(tmp_path):
    runner = FakeRunner()
    runner.stdout_for[("shortcuts", "list")] = "Morning Routine\nResize Image\n"
    ctl = make_controller(tmp_path, runner=runner)
    bad = mc.MacRunShortcutTool(ctl).execute(name="Delete Everything")
    assert not bad.success and ctl.store.list_pending() == []
    t, seen = approve_when_pending(ctl.store)
    ok = mc.MacRunShortcutTool(ctl).execute(name="morning routine")
    t.join(5)
    assert ok.success
    assert ["shortcuts", "run", "Morning Routine"] in runner.calls
    assert "Shortcut 'Morning Routine'" in seen["action"].description


# ---------------------------------------------------------------------------
# Rate limits
# ---------------------------------------------------------------------------


def test_risky_rate_limit(tmp_path):
    now = [0.0]
    ctl = make_controller(
        tmp_path, clock=lambda: now[0], max_risky_per_minute=2, approval_timeout_s=5
    )
    ctl._sleep = lambda s: now.__setitem__(0, now[0] + 0.001)
    tool = mc.MacPressKeysTool(ctl)
    for _ in range(2):
        t, _ = approve_when_pending(ctl.store)
        assert tool.execute(keys="down").success
        t.join(5)
    third = tool.execute(keys="down")
    assert not third.success and "Rate limit" in third.content
    assert ctl.store.list_pending() == []
    now[0] += 61
    t, _ = approve_when_pending(ctl.store)
    assert tool.execute(keys="down").success
    t.join(5)


def test_safe_rate_limit_separate(tmp_path):
    ctl = make_controller(tmp_path, max_safe_per_minute=1)
    tool = mc.MacOpenAppTool(ctl)
    assert tool.execute(name="Safari").success
    assert "Rate limit" in tool.execute(name="Safari").content


# ---------------------------------------------------------------------------
# Integration with shared approval system / executor
# ---------------------------------------------------------------------------


def test_execute_pending_actions_skips_mac_actions(tmp_path):
    from openjarvis.tools.proactive_tools import ExecutePendingActionsTool

    store = ApprovalStore(str(tmp_path / "a.db"))
    a = store.queue_action("mac_type_text", "d", {}, "k", "high", ttl_seconds=60)
    store.update_status(a.id, STATUS_APPROVED)
    calls = []
    tool = ExecutePendingActionsTool(
        store=store, executor_fn=lambda act: calls.append(act) or (True, "")
    )
    tool.execute()
    assert calls == []


def test_status_snapshot(tmp_path):
    ctl = make_controller(tmp_path, ax=False, screen=None)
    snap = mc.status_snapshot(ctl)
    assert snap["enabled"] is True and snap["stopped"] is False
    assert snap["permissions"] == {"accessibility": False, "screen_recording": None}
    assert snap["tools"]["mac_click"] == "risky"
    assert snap["safe_actions"] and snap["ask_first_actions"]


def test_routes_status_stop_resume_and_late_approve(tmp_path):
    pytest.importorskip("fastapi")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from openjarvis.server import approval_routes
    from openjarvis.server.mac_control_routes import router

    ctl = make_controller(tmp_path)
    mc.set_controller(ctl)
    app = FastAPI()
    app.include_router(router)
    app.include_router(approval_routes.router)
    old_store = approval_routes._store
    approval_routes._store = ctl.store
    try:
        client = TestClient(app)
        assert client.get("/v1/mac-control/status").json()["enabled"] is True
        stale = ctl.store.queue_action(
            "mac_click", "d", {}, "k", "high", ttl_seconds=60
        )
        ctl.store.update_status(stale.id, STATUS_EXPIRED)
        assert client.post(f"/v1/approvals/{stale.id}/approve").status_code == 409
        pending = ctl.store.queue_action(
            "mac_click", "d", {}, "k", "high", ttl_seconds=60
        )
        body = client.post("/v1/mac-control/stop").json()
        assert body == {"stopped": True, "denied_pending": 1}
        assert ctl.store.get_action(pending.id).status == STATUS_DENIED
        assert client.get("/v1/mac-control/status").json()["stopped"] is True
        assert client.post("/v1/mac-control/resume").json() == {"stopped": False}
    finally:
        approval_routes._store = old_store


def test_executor_records_untrusted_reads(tmp_path):
    from openjarvis.core.types import ToolCall, ToolResult
    from openjarvis.tools._stubs import BaseTool, ToolExecutor, ToolSpec

    class Remote(BaseTool):
        tool_id = "remote_reader"
        is_local = False

        @property
        def spec(self):
            return ToolSpec(name="remote_reader", description="x")

        def execute(self, **params):
            return ToolResult(tool_name="remote_reader", content="page text")

    ToolExecutor([Remote()]).execute(
        ToolCall(id="1", name="remote_reader", arguments="{}")
    )
    assert "remote_reader" in untrusted_context.recent_untrusted_sources()


def test_glide_moves_in_small_steps_and_lands_on_target(monkeypatch):
    """The pointer travels visibly (many small moves) and ends exactly there."""
    q = mc.QuartzEvents.__new__(mc.QuartzEvents)
    moves = []
    q.position = lambda: (0.0, 0.0)
    q.move = lambda x, y: moves.append((x, y))
    monkeypatch.setattr(mc.time, "sleep", lambda s: None)
    q.glide(400, 300)
    assert len(moves) >= 8
    assert moves[-1] == (400, 300)
    xs = [m[0] for m in moves]
    assert xs == sorted(xs)  # never jumps backwards


def test_move_mouse_is_safe_and_bounded():
    assert mc.risk_of("mac_move_mouse") == mc.RISK_SAFE
    tool = mc.MacMoveMouseTool.__new__(mc.MacMoveMouseTool)
    with pytest.raises(ValueError):
        tool._prepare({"x": -5, "y": 10})


# ---------------------------------------------------------------------------
# Browser tabs (read straight from the browser, no screenshot)
# ---------------------------------------------------------------------------


def _tabs_runner(out: str) -> FakeRunner:
    runner = FakeRunner(front="Jarvis\nJarvis")
    runner.stdout_for = {}

    orig = runner.__call__

    def call(cmd, timeout):
        res = orig(cmd, timeout)
        if any("active tab index" in part or "current tab of w" in part for part in cmd):
            return subprocess.CompletedProcess(list(cmd), 0, out, "")
        return res

    return call  # type: ignore[return-value]


def test_browser_tabs_lists_active_tab(tmp_path):
    out = "1\t-\tInbox - Gmail\thttps://mail.google.com/\n1\t*\tYouTube\thttps://www.youtube.com/\n"
    ctl = make_controller(tmp_path, runner=_tabs_runner(out))
    result = mc.MacBrowserTabsTool(ctl).execute()
    assert result.success
    assert "* window 1: YouTube" in result.content
    assert "  window 1: Inbox - Gmail" in result.content
    assert "App in front: Jarvis" in result.content


def test_browser_tabs_not_running_and_unknown_browser(tmp_path):
    ctl = make_controller(tmp_path, runner=_tabs_runner("NOT_RUNNING"))
    assert "not open" in mc.MacBrowserTabsTool(ctl).execute(browser="Safari").content
    bad = mc.MacBrowserTabsTool(ctl).execute(browser='Finder" to do shell script "x')
    assert not bad.success


def test_browser_tabs_is_safe():
    assert mc.risk_of("mac_browser_tabs") == mc.RISK_SAFE


def test_screenshot_brings_app_forward(tmp_path, monkeypatch):
    runner = FakeRunner(front="Google Chrome\nYouTube")
    ctl = make_controller(tmp_path, runner=runner, sleep=lambda s: None)
    tool = mc.MacScreenshotDescribeTool(ctl)
    action, clean = tool._prepare({"question": "what tab?", "app": "chrome"})
    assert clean["app"] == "Google Chrome"
    assert "bring Google Chrome forward" in action


# ---------------------------------------------------------------------------
# Jarvis's own window is on top while Filo chats: look past it
# ---------------------------------------------------------------------------

BEHIND = [
    {"owner": "Jarvis", "title": "Jarvis", "id": 10},
    {"owner": "Google Chrome", "title": "YouTube", "id": 42},
    {"owner": "Finder", "title": "Downloads", "id": 7},
]


def test_frontmost_looks_past_jarvis(tmp_path):
    ctl = make_controller(tmp_path, runner=FakeRunner(front="Jarvis\nJarvis"), windows=BEHIND)
    result = mc.MacFrontmostTool(ctl).execute()
    assert result.success
    assert result.content.startswith("Filo is using: Google Chrome — window: YouTube")
    assert "Don't offer to switch" in result.content


def test_frontmost_other_app_unchanged(tmp_path):
    ctl = make_controller(tmp_path, runner=FakeRunner(front="Notes\nList"), windows=BEHIND)
    assert "Frontmost app: Notes" in mc.MacFrontmostTool(ctl).execute().content


def test_window_of_and_app_behind(tmp_path):
    ctl = make_controller(tmp_path, windows=BEHIND)
    assert ctl.app_behind_me() == ("Google Chrome", "YouTube")
    assert ctl.window_of("google chrome") == 42
    assert ctl.window_of("Safari") is None
    assert mc.is_self_app("OpenJarvis") and not mc.is_self_app("Chrome")


def test_screenshot_captures_app_behind_jarvis_without_switching(tmp_path):
    runner = ShotRunner(front="Jarvis\nJarvis")
    ctl = make_controller(tmp_path, runner=runner, windows=BEHIND)
    ctl.http_client = FakeHttp()
    result = mc.MacScreenshotDescribeTool(ctl).execute(question="What tab?")
    assert result.success, result.content
    shot_cmd = next(c for c in runner.calls if c[0] == "screencapture")
    assert shot_cmd[shot_cmd.index("-l") + 1] == "42"  # Chrome's window, not Jarvis
    assert not any(c[:2] == ["open", "-a"] for c in runner.calls)
    assert "Google Chrome" in result.content
