"""Build a small "memory web" from what OpenJarvis stores locally.

The Mind page in the UI draws memories as glowing nodes connected by edges.
This module turns the local stores into that graph:

* **facts** — automatic long-term memory (``memory_facts.jsonl``)
* **docs** — the retrieval document store (``memory.db``, FTS5)
* **entities** — the knowledge graph (``knowledge_graph.db``) and its relations
* **notes** — bullet points from the persona files ``MEMORY.md`` / ``USER.md``

Edges come from real KG relations, documents sharing a ``source``, entity
names mentioned in a memory's text, and a cheap keyword-overlap similarity.

Everything is read-only (SQLite opened with ``mode=ro``), capped in size and
never leaves the machine.  Node ids are derived from content (see
:func:`memory_node_id`) so retrieval events — which only see content — can be
linked back to the node they lit up.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

MAX_NODES = 300
MAX_EDGES = 900
LABEL_CHARS = 160
TEXT_CHARS = 600

_WORD_RE = re.compile(r"[a-z0-9]+")

STOPWORDS = frozenset(
    """
    a about above after again against all am an and any are as at be because
    been before being below between both but by can could did do does doing
    down during each few for from further had has have having he her here hers
    herself him himself his how i if in into is it its itself just me more most
    my myself no nor not now of off on once only or other our ours ourselves
    out over own same she should so some such than that the their theirs them
    themselves then there these they this those through to too under until up
    very was we were what when where which while who whom why will with would
    you your yours yourself yourselves user users user's s t don ll ve re d m
    """.split()
)


# ---------------------------------------------------------------------------
# Shared helpers (also used by retrieval to tag events)
# ---------------------------------------------------------------------------


def memory_node_id(kind: str, text: str) -> str:
    """Stable, content-derived node id: ``<kind>:<12 hex chars>``.

    Retrieval only sees content (the FTS backend does not return document
    ids), so hashing the normalized text lets a retrieval event point at the
    same node the graph endpoint produced.
    """
    norm = " ".join((text or "").lower().split())
    digest = hashlib.sha1(norm.encode("utf-8")).hexdigest()[:12]
    return f"{kind}:{digest}"


def tokenize(text: str) -> List[str]:
    """Lowercase alphanumeric tokens with stopwords and short words removed.

    A tiny suffix strip (``s``/``ing``/``ed``) makes ``coffee`` match
    ``coffees`` without pulling in a stemmer dependency.
    """
    out: List[str] = []
    for word in _WORD_RE.findall((text or "").lower()):
        if len(word) < 2 or word in STOPWORDS:
            continue
        for suffix in ("ing", "ed", "s"):
            if len(word) > len(suffix) + 2 and word.endswith(suffix):
                word = word[: -len(suffix)]
                break
        out.append(word)
    return out


def _clip(text: str, limit: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _to_unix(ts: Any) -> float:
    """Normalize timestamps: the Rust store writes ``julianday('now')``."""
    try:
        value = float(ts or 0.0)
    except (TypeError, ValueError):
        return 0.0
    if 0 < value < 1e7:  # Julian day number, not a unix timestamp
        return (value - 2440587.5) * 86400.0
    return value


def _open_ro(path: Path) -> Optional[sqlite3.Connection]:
    if not path.is_file():
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=1.0)
        conn.execute("PRAGMA query_only = 1")
        return conn
    except sqlite3.Error:
        return None


# ---------------------------------------------------------------------------
# Graph model
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class _Node:
    id: str
    label: str
    kind: str
    text: str
    created_at: float = 0.0
    raw_weight: float = 1.0
    source: str = ""
    tokens: Set[str] = field(default_factory=set)

    def as_dict(self, weight: float) -> Dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "kind": self.kind,
            "text": self.text,
            "weight": round(weight, 4),
            "created_at": self.created_at,
        }


class _GraphBuilder:
    def __init__(self, max_nodes: int) -> None:
        self.max_nodes = max_nodes
        self.nodes: Dict[str, _Node] = {}
        self.edges: Dict[Tuple[str, str], str] = {}

    def add_node(self, node: _Node) -> bool:
        if node.id in self.nodes or len(self.nodes) >= self.max_nodes:
            return node.id in self.nodes
        node.tokens = set(tokenize(node.text))
        self.nodes[node.id] = node
        return True

    def add_edge(self, a: str, b: str, kind: str) -> None:
        if a == b or a not in self.nodes or b not in self.nodes:
            return
        key = (a, b) if a < b else (b, a)
        # Real relations win over derived ones when both exist.
        if key not in self.edges or self.edges[key] == "similar":
            self.edges[key] = kind


def _load_facts(builder: _GraphBuilder, facts: Sequence[Any], cap: int) -> None:
    trusted = [f for f in facts if bool(getattr(f, "trusted_for_recall", True))]
    for fact in list(reversed(trusted))[:cap]:  # newest first
        text = str(getattr(fact, "text", "") or "").strip()
        if not text:
            continue
        builder.add_node(
            _Node(
                id=memory_node_id("fact", text),
                label=_clip(text, LABEL_CHARS),
                kind="fact",
                text=_clip(text, TEXT_CHARS),
                created_at=float(getattr(fact, "created_at", 0.0) or 0.0),
                raw_weight=1.5,
                source="fact",
            )
        )


def _metadata_trusted(raw: Any) -> bool:
    if not raw:
        return True
    try:
        meta = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return True
    if not isinstance(meta, dict):
        return False
    from openjarvis.memory.store import RECALLABLE_TRUST_TIERS

    tier = str(meta.get("trust", "") or "").strip().lower()
    return tier in RECALLABLE_TRUST_TIERS


def _load_documents(builder: _GraphBuilder, db_path: Path, cap: int) -> None:
    conn = _open_ro(db_path)
    if conn is None:
        return
    try:
        rows = conn.execute(
            "SELECT content, source, metadata, created_at FROM documents "
            "ORDER BY created_at DESC LIMIT ?",
            (cap,),
        ).fetchall()
    except sqlite3.Error:
        rows = []
    finally:
        conn.close()
    for content, source, metadata, created_at in rows:
        content = str(content or "").strip()
        if not content or not _metadata_trusted(metadata):
            continue
        builder.add_node(
            _Node(
                id=memory_node_id("doc", content),
                label=_clip(content, LABEL_CHARS),
                kind="doc",
                text=_clip(content, TEXT_CHARS),
                created_at=_to_unix(created_at),
                raw_weight=1.0 + min(len(content), 4000) / 4000.0,
                source=str(source or ""),
            )
        )


def _load_knowledge_graph(builder: _GraphBuilder, db_path: Path, cap: int) -> None:
    conn = _open_ro(db_path)
    if conn is None:
        return
    try:
        entities = conn.execute(
            "SELECT e.entity_id, e.entity_type, e.name, e.properties, e.created_at,"
            " (SELECT COUNT(*) FROM relations r"
            "   WHERE r.source_id = e.entity_id OR r.target_id = e.entity_id) AS deg"
            " FROM entities e ORDER BY deg DESC, e.created_at DESC LIMIT ?",
            (cap,),
        ).fetchall()
        relations = conn.execute(
            "SELECT source_id, target_id, relation_type FROM relations "
            "ORDER BY weight DESC LIMIT ?",
            (MAX_EDGES,),
        ).fetchall()
    except sqlite3.Error:
        entities, relations = [], []
    finally:
        conn.close()
    for entity_id, entity_type, name, props, created_at, degree in entities:
        name = str(name or entity_id or "").strip()
        if not name:
            continue
        detail = ""
        try:
            parsed = json.loads(props or "{}")
            if isinstance(parsed, dict) and parsed.get("content"):
                detail = str(parsed["content"])
        except (TypeError, ValueError):
            pass
        text = f"{name} ({entity_type})" + (f": {detail}" if detail else "")
        builder.add_node(
            _Node(
                id=f"kg:{entity_id}",
                label=_clip(name, LABEL_CHARS),
                kind="entity",
                text=_clip(text, TEXT_CHARS),
                created_at=_to_unix(created_at),
                raw_weight=1.0 + min(int(degree or 0), 20) / 5.0,
                source="knowledge_graph",
            )
        )
    for source_id, target_id, rel_type in relations:
        builder.add_edge(f"kg:{source_id}", f"kg:{target_id}", str(rel_type or "kg"))


_BULLET_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$")


def _load_note_files(builder: _GraphBuilder, paths: Iterable[Path], cap: int) -> None:
    added = 0
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        try:
            mtime = path.stat().st_mtime
        except OSError:
            mtime = 0.0
        for line in text.splitlines():
            m = _BULLET_RE.match(line)
            body = m.group(1) if m else ""
            if not body and line.strip() and not line.lstrip().startswith("#"):
                body = line.strip()
            if len(body) < 4:
                continue
            if builder.add_node(
                _Node(
                    id=memory_node_id("note", body),
                    label=_clip(body, LABEL_CHARS),
                    kind="note",
                    text=_clip(body, TEXT_CHARS),
                    created_at=mtime,
                    raw_weight=1.2,
                    source=path.name,
                )
            ):
                added += 1
            if added >= cap:
                return


def _link_shared_sources(builder: _GraphBuilder) -> None:
    by_source: Dict[str, List[str]] = {}
    for node in builder.nodes.values():
        if node.kind == "doc" and node.source:
            by_source.setdefault(node.source, []).append(node.id)
    for ids in by_source.values():
        # A chain (not a clique) keeps big sources from exploding the edges.
        for a, b in zip(ids, ids[1:]):
            builder.add_edge(a, b, "same_source")


def _link_entity_mentions(builder: _GraphBuilder) -> None:
    entities = [
        (n.id, n.label.lower())
        for n in builder.nodes.values()
        if n.kind == "entity" and len(n.label) >= 3
    ]
    if not entities:
        return
    for node in builder.nodes.values():
        if node.kind == "entity":
            continue
        lowered = node.text.lower()
        for entity_id, name in entities:
            if re.search(rf"(?<![a-z0-9]){re.escape(name)}(?![a-z0-9])", lowered):
                builder.add_edge(node.id, entity_id, "mentions")


def _link_similar(builder: _GraphBuilder, per_node: int = 2) -> None:
    """Connect each node to its most keyword-similar peers (Jaccard)."""
    items = [(n.id, n.tokens) for n in builder.nodes.values() if n.tokens]
    for i, (a_id, a_tok) in enumerate(items):
        scored: List[Tuple[float, str]] = []
        for j, (b_id, b_tok) in enumerate(items):
            if i == j:
                continue
            inter = len(a_tok & b_tok)
            if not inter:
                continue
            score = inter / len(a_tok | b_tok)
            if score >= 0.18:
                scored.append((score, b_id))
        scored.sort(reverse=True)
        for _, b_id in scored[:per_node]:
            builder.add_edge(a_id, b_id, "similar")


def build_memory_graph(
    *,
    facts: Sequence[Any] = (),
    memory_db: Optional[Path] = None,
    knowledge_graph_db: Optional[Path] = None,
    note_files: Sequence[Path] = (),
    hit_counts: Optional[Dict[str, int]] = None,
    max_nodes: int = MAX_NODES,
) -> Dict[str, Any]:
    """Return ``{"nodes": [...], "edges": [...], "stats": {...}}``.

    ``hit_counts`` (node id -> times recalled this session) boosts the weight
    of memories that were actually used, so frequently-recalled ones glow
    bigger.
    """
    max_nodes = max(1, min(int(max_nodes), MAX_NODES))
    # Each store is read into its own pool (each already newest/most-connected
    # first), then the node budget is shared fairly so one huge store cannot
    # crowd out the others while unused share flows to whoever has more.
    pools: List[_GraphBuilder] = [_GraphBuilder(max_nodes) for _ in range(4)]
    _load_facts(pools[0], facts, max_nodes)
    _load_note_files(pools[1], note_files, max_nodes)
    if knowledge_graph_db is not None:
        _load_knowledge_graph(pools[2], knowledge_graph_db, max_nodes)
    if memory_db is not None:
        _load_documents(pools[3], memory_db, max_nodes)

    queues = [list(pool.nodes.values()) for pool in pools]
    builder = _GraphBuilder(max_nodes)
    while len(builder.nodes) < max_nodes and any(queues):
        for queue in queues:  # round-robin: one node per store per pass
            if queue and len(builder.nodes) < max_nodes:
                builder.add_node(queue.pop(0))
    for pool in pools:
        for (a, b), kind in pool.edges.items():
            builder.add_edge(a, b, kind)

    _link_shared_sources(builder)
    _link_entity_mentions(builder)
    _link_similar(builder)

    hits = hit_counts or {}
    raw = {
        nid: n.raw_weight + 0.5 * min(hits.get(nid, 0), 10)
        for nid, n in builder.nodes.items()
    }
    degree: Dict[str, int] = {}
    for a, b in builder.edges:
        degree[a] = degree.get(a, 0) + 1
        degree[b] = degree.get(b, 0) + 1
    for nid in raw:
        raw[nid] += 0.15 * min(degree.get(nid, 0), 10)
    top = max(raw.values(), default=1.0) or 1.0

    nodes = [n.as_dict(raw[n.id] / top) for n in builder.nodes.values()]
    edges = [
        {"source": a, "target": b, "kind": kind}
        for (a, b), kind in list(builder.edges.items())[:MAX_EDGES]
    ]
    kinds: Dict[str, int] = {}
    for n in nodes:
        kinds[n["kind"]] = kinds.get(n["kind"], 0) + 1
    return {
        "nodes": nodes,
        "edges": edges,
        "stats": {"nodes": len(nodes), "edges": len(edges), "kinds": kinds},
    }


__all__ = [
    "MAX_NODES",
    "build_memory_graph",
    "memory_node_id",
    "tokenize",
]
