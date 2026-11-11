"""Mind page API: the local memory web plus a live stream of "thoughts".

* ``GET /v1/mind/graph`` — memories (facts, documents, knowledge-graph
  entities, MEMORY.md/USER.md notes) as nodes, with relation / shared-source /
  mention / similarity edges.  Built read-only from local files.
* ``GET /v1/mind/stream`` — Server-Sent Events.  Agent turns, inference,
  tool calls, memory recall and final answers from the EventBus are turned
  into short, redacted "thought bubbles" that reference the memory nodes they
  used.

Nothing here makes a network call; it only reads what is already on disk and
what is published on the in-process event bus.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import re
import threading
import time
from collections import Counter, deque
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional, Set, Tuple

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from openjarvis.core.events import Event, EventBus, EventType, get_event_bus

logger = logging.getLogger(__name__)

TEXT_LIMIT = 240
REPLAY_LIMIT = 30
_HEARTBEAT_SECONDS = 15.0

_SUBSCRIBED_EVENTS = (
    EventType.AGENT_TURN_START,
    EventType.AGENT_TURN_END,
    EventType.INFERENCE_START,
    EventType.INFERENCE_END,
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_END,
    EventType.MEMORY_RETRIEVE,
    EventType.MEMORY_STORE,
    EventType.CHAT_EXCHANGE_COMPLETED,
)

# Tool arguments that are safe and useful to show ("Searching memory for …").
# Everything else (headers, bodies, file contents, credentials) is withheld.
_SAFE_ARG_KEYS = ("query", "q", "question", "expression", "topic", "city", "path")


# ---------------------------------------------------------------------------
# Redaction / formatting
# ---------------------------------------------------------------------------


def _secret_patterns() -> List[re.Pattern[str]]:
    patterns: List[str] = [
        r"oj_sk_[A-Za-z0-9_-]{16,}",
        r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{12,}",
        r"(?i)(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S{6,}",
    ]
    try:
        from openjarvis.security.scanner import SecretScanner

        patterns += [spec[0] for spec in SecretScanner.PATTERNS.values()]
    except Exception:  # noqa: BLE001 — fall back to the built-in list
        pass
    compiled = []
    for pat in patterns:
        try:
            compiled.append(re.compile(pat))
        except re.error:
            continue
    return compiled


_SECRETS = _secret_patterns()


def redact(text: str) -> str:
    """Mask anything that looks like a credential."""
    for pattern in _SECRETS:
        text = pattern.sub("[redacted]", text)
    return text


def clean_text(value: Any, limit: int = TEXT_LIMIT) -> str:
    """Collapse whitespace, redact secrets and truncate to *limit* chars."""
    text = " ".join(str(value or "").split())
    text = redact(text)
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


def _arg_preview(arguments: Any) -> str:
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except (TypeError, ValueError):
            return ""
    if not isinstance(arguments, dict):
        return ""
    for key in _SAFE_ARG_KEYS:
        value = arguments.get(key)
        if isinstance(value, (str, int, float)) and str(value).strip():
            return clean_text(value, 80)
    return ""


def _tool_names(tool_calls: Any) -> List[str]:
    names: List[str] = []
    for call in tool_calls or []:
        name = ""
        if isinstance(call, dict):
            fn = call.get("function")
            name = (fn.get("name") if isinstance(fn, dict) else "") or call.get(
                "name", ""
            )
        else:
            name = getattr(call, "name", "") or ""
        if name:
            names.append(str(name))
    return names


def event_to_thought(event: Event) -> Optional[Dict[str, Any]]:
    """Translate a bus event into a Mind-stream bubble (or ``None`` to skip).

    Returned shape (without ``id``, which the hub assigns)::

        {"type": "thought"|"tool"|"memory_hit"|"answer",
         "event": <EventType value>, "text": str, "links": [nodeId], "ts": float}
    """
    data = event.data or {}
    etype = event.event_type
    kind: str
    text: str
    links: List[str] = []

    if etype == EventType.AGENT_TURN_START:
        query = clean_text(data.get("input", ""), 160)
        if not query:
            return None
        kind, text = "thought", f"Thinking about: {query}"
    elif etype == EventType.INFERENCE_START:
        model = clean_text(data.get("model", ""), 60)
        kind, text = "thought", f"Reasoning with {model}" if model else "Reasoning…"
    elif etype == EventType.INFERENCE_END:
        names = _tool_names(data.get("tool_calls"))
        if not names:
            return None
        kind, text = "thought", "Decided to use " + ", ".join(names[:4])
    elif etype == EventType.TOOL_CALL_START:
        tool = clean_text(data.get("tool", "tool"), 60)
        preview = _arg_preview(data.get("arguments"))
        kind = "tool"
        text = f"Using {tool}" + (f": {preview}" if preview else "")
    elif etype == EventType.TOOL_CALL_END:
        tool = clean_text(data.get("tool", "tool"), 60)
        ok = "done" if data.get("success", True) else "failed"
        latency = data.get("latency")
        took = f" in {float(latency):.1f}s" if isinstance(latency, (int, float)) else ""
        kind, text = "tool", f"{tool} {ok}{took}"
    elif etype == EventType.MEMORY_RETRIEVE:
        links = [str(n) for n in (data.get("node_ids") or []) if n][:24]
        count = int(data.get("num_results", 0) or 0) + int(
            data.get("num_facts", 0) or 0
        )
        query = clean_text(data.get("query", ""), 80)
        kind = "memory_hit"
        if count:
            noun = "memory" if count == 1 else "memories"
            text = f"Recalled {count} {noun}" + (f" for “{query}”" if query else "")
        else:
            text = "Searched memory" + (f" for “{query}”" if query else "")
            text += " — nothing relevant"
    elif etype == EventType.MEMORY_STORE:
        node_id = data.get("node_id")
        links = [str(node_id)] if node_id else []
        kind, text = "memory_hit", "Saved a new memory"
    elif etype == EventType.CHAT_EXCHANGE_COMPLETED:
        answer = clean_text(data.get("assistant_text", ""))
        if not answer:
            return None
        kind, text = "answer", answer
    elif etype == EventType.AGENT_TURN_END:
        answer = clean_text(data.get("content", "") or data.get("answer", ""))
        if not answer:
            return None
        kind, text = "answer", answer
    else:
        return None

    return {
        "type": kind,
        "event": etype.value,
        "text": text,
        "links": links,
        "ts": event.timestamp,
    }


# ---------------------------------------------------------------------------
# Hub: bus subscriptions -> fan-out to SSE clients
# ---------------------------------------------------------------------------


class MindHub:
    """Subscribes to one or more event buses and fans thoughts out to clients.

    Keeps a short replay buffer so a freshly-opened Mind page shows the most
    recent turn, and counts how often each memory node was recalled so the
    graph can make well-used memories glow bigger.
    """

    def __init__(self, buses: List[EventBus]) -> None:
        unique: List[EventBus] = []
        for bus in buses:
            if bus is not None and all(bus is not b for b in unique):
                unique.append(bus)
        self._buses = unique
        self._lock = threading.Lock()
        self._ids = itertools.count(1)
        self._recent: Deque[Dict[str, Any]] = deque(maxlen=REPLAY_LIMIT)
        self._clients: Set[Tuple[asyncio.Queue, asyncio.AbstractEventLoop]] = set()
        self.hit_counts: Counter[str] = Counter()
        self._last_answer: Tuple[str, float] = ("", 0.0)
        for bus in self._buses:
            for etype in _SUBSCRIBED_EVENTS:
                bus.subscribe(etype, self._on_event)

    def close(self) -> None:
        for bus in self._buses:
            for etype in _SUBSCRIBED_EVENTS:
                bus.unsubscribe(etype, self._on_event)
        self._buses = []

    def recent(self) -> List[Dict[str, Any]]:
        with self._lock:
            return list(self._recent)

    def _on_event(self, event: Event) -> None:
        thought = event_to_thought(event)
        if thought is None:
            return
        with self._lock:
            if thought["type"] == "answer":
                # The same reply can arrive as AGENT_TURN_END and as
                # CHAT_EXCHANGE_COMPLETED; show it once.
                last_text, last_ts = self._last_answer
                if thought["text"] == last_text and thought["ts"] - last_ts < 30:
                    return
                self._last_answer = (thought["text"], thought["ts"])
            thought["id"] = f"t{next(self._ids)}"
            if thought["type"] == "memory_hit" and thought["event"] == (
                EventType.MEMORY_RETRIEVE.value
            ):
                self.hit_counts.update(thought["links"])
            self._recent.append(thought)
            clients = list(self._clients)
        for queue, loop in clients:
            try:
                loop.call_soon_threadsafe(_offer, queue, thought)
            except RuntimeError:
                pass  # loop closed; the client is going away

    def add_client(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=200)
        with self._lock:
            self._clients.add((queue, asyncio.get_running_loop()))
        return queue

    def remove_client(self, queue: asyncio.Queue) -> None:
        with self._lock:
            self._clients = {c for c in self._clients if c[0] is not queue}


def _offer(queue: asyncio.Queue, item: Dict[str, Any]) -> None:
    try:
        queue.put_nowait(item)
    except asyncio.QueueFull:
        pass  # slow client: drop rather than grow without bound


# ---------------------------------------------------------------------------
# Graph data sources
# ---------------------------------------------------------------------------


def _config_dir() -> Path:
    from openjarvis.core.paths import get_config_dir

    return Path(get_config_dir())


def _load_facts(request: Request, config: Any) -> List[Any]:
    service = getattr(request.app.state, "memory_service", None)
    if service is not None:
        try:
            return list(service.list_facts())
        except Exception:  # noqa: BLE001
            logger.debug("Mind: memory service facts unavailable", exc_info=True)
    memory = getattr(config, "memory", None)
    path = Path(
        getattr(memory, "facts_path", "") or _config_dir() / "memory_facts.jsonl"
    ).expanduser()
    if not path.is_file():
        return []
    try:
        from openjarvis.memory.store import LocalFactStore

        # Construction and list() only read the JSONL file.
        return LocalFactStore(path).list()
    except Exception:  # noqa: BLE001
        logger.debug("Mind: could not read facts", exc_info=True)
        return []


def collect_graph(request: Request, limit: int) -> Dict[str, Any]:
    from openjarvis.memory.graph import build_memory_graph

    config = getattr(request.app.state, "config", None)
    memory = getattr(config, "memory", None)
    files = getattr(config, "memory_files", None)
    base = _config_dir()
    memory_db = Path(getattr(memory, "db_path", "") or base / "memory.db").expanduser()
    note_files = [
        Path(p).expanduser()
        for p in (
            getattr(files, "memory_path", "") or base / "MEMORY.md",
            getattr(files, "user_path", "") or base / "USER.md",
        )
    ]
    hub: Optional[MindHub] = getattr(request.app.state, "mind_hub", None)
    return build_memory_graph(
        facts=_load_facts(request, config),
        memory_db=memory_db,
        knowledge_graph_db=base / "knowledge_graph.db",
        note_files=note_files,
        hit_counts=dict(hub.hit_counts) if hub is not None else None,
        max_nodes=limit,
    )


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def create_mind_router() -> APIRouter:
    router = APIRouter(prefix="/v1/mind", tags=["mind"])

    @router.get("/graph")
    def mind_graph(
        request: Request,
        limit: int = Query(300, ge=1, le=300),
    ) -> Dict[str, Any]:
        started = time.perf_counter()
        graph = collect_graph(request, limit)
        graph["stats"]["build_ms"] = round((time.perf_counter() - started) * 1000, 1)
        return graph

    @router.get("/recent")
    def mind_recent(request: Request) -> Dict[str, Any]:
        hub: Optional[MindHub] = getattr(request.app.state, "mind_hub", None)
        return {"thoughts": hub.recent() if hub is not None else []}

    @router.get("/stream")
    async def mind_stream(request: Request) -> StreamingResponse:
        hub: Optional[MindHub] = getattr(request.app.state, "mind_hub", None)

        async def events():
            if hub is None:
                yield ": mind stream unavailable\n\n"
                return
            queue = hub.add_client()
            try:
                yield "retry: 3000\n\n"
                for thought in hub.recent():
                    yield _sse({**thought, "replay": True})
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        thought = await asyncio.wait_for(
                            queue.get(), timeout=_HEARTBEAT_SECONDS
                        )
                    except asyncio.TimeoutError:
                        yield ": keep-alive\n\n"
                        continue
                    yield _sse(thought)
            finally:
                hub.remove_client(queue)

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return router


def _sse(payload: Dict[str, Any]) -> str:
    return f"event: thought\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def include_mind_routes(app: Any) -> None:
    """Attach the Mind hub + router to *app* (idempotent)."""
    if getattr(app.state, "mind_hub", None) is not None:
        return
    # Agents/tools publish on the server-owned bus; storage backends and
    # context injection publish on the module singleton. Listen to both.
    hub = MindHub([getattr(app.state, "bus", None), get_event_bus()])
    app.state.mind_hub = hub
    try:
        app.router.on_shutdown.append(hub.close)
    except AttributeError:  # pragma: no cover — very old/new Starlette
        logger.debug("Mind hub: no shutdown hook available")
    app.include_router(create_mind_router())


__all__ = [
    "MindHub",
    "clean_text",
    "create_mind_router",
    "event_to_thought",
    "include_mind_routes",
    "redact",
]
