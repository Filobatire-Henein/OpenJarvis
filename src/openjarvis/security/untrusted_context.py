"""Process-wide record of recently-read untrusted content.

Tools that hand the model text it did not write itself (web pages, search
results, screenshots, emails, ...) note it here.  Tools that *act* on the
user's computer (``mac_control`` risky actions) consult it so the approval
prompt can warn: "Jarvis recently read web/screen content — this request may
have come from that content rather than from you."

Deliberately tiny and dependency-free so ``ToolExecutor`` can call it on every
tool result without import cost.
"""

from __future__ import annotations

import threading
import time
from typing import Dict, List, Optional

# Tool names whose output is content Jarvis *read* from somewhere else, even
# though the tool itself runs locally (is_local=True).
UNTRUSTED_READ_TOOLS = frozenset(
    {
        "web_search",
        "http_request",
        "browser_navigate",
        "browser_extract",
        "browser_screenshot",
        "browser_axtree",
        "digest_collect",
        "pdf_extract",
        "mac_screenshot_describe",
        "mac_search",
    }
)

_lock = threading.Lock()
_seen: Dict[str, float] = {}


def note_untrusted_content(source: str, *, now: Optional[float] = None) -> None:
    """Record that content from *source* (a tool name) was just read."""
    if not source:
        return
    with _lock:
        _seen[source] = time.time() if now is None else now


def note_tool_output(tool_name: str, is_local: bool) -> None:
    """Called by ToolExecutor after every successful tool call."""
    if not is_local or tool_name in UNTRUSTED_READ_TOOLS:
        note_untrusted_content(tool_name)


def recent_untrusted_sources(
    window_s: float = 600.0, *, now: Optional[float] = None
) -> List[str]:
    """Return sources read within the last *window_s* seconds (sorted)."""
    current = time.time() if now is None else now
    with _lock:
        return sorted(s for s, t in _seen.items() if current - t <= window_s)


def clear() -> None:
    """Forget everything (tests / new session)."""
    with _lock:
        _seen.clear()


__all__ = [
    "UNTRUSTED_READ_TOOLS",
    "clear",
    "note_tool_output",
    "note_untrusted_content",
    "recent_untrusted_sources",
]
