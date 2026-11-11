"""Relevance-ranked recall of long-term facts + recall events for the Mind page."""

from __future__ import annotations

import time

from openjarvis.core.events import EventBus, EventType
from openjarvis.core.types import Message, Role
from openjarvis.memory.graph import memory_node_id
from openjarvis.memory.store import Fact
from openjarvis.tools.storage._stubs import MemoryBackend, RetrievalResult
from openjarvis.tools.storage.context import (
    ContextConfig,
    inject_context,
    rank_facts,
)


class _Fixed(MemoryBackend):
    backend_id = "fixed"

    def __init__(self, results):
        self._results = results

    def store(self, content, *, source="", metadata=None):
        return "id"

    def retrieve(self, query, *, top_k=5, **kwargs):
        return self._results[:top_k]

    def delete(self, doc_id):
        return False

    def clear(self):
        pass


def _filler(n):
    return [Fact(text=f"Unrelated filler fact {i} about gardening") for i in range(n)]


def test_rank_facts_puts_relevant_first_then_newest():
    facts = [
        Fact(text="User's sister is called Mariam"),
        *_filler(3),
        Fact(text="User drinks oat milk lattes"),
    ]
    ranked = rank_facts("what milk do I like in my latte?", facts)
    assert ranked[0].text == "User drinks oat milk lattes"
    # Non-matching facts follow in newest-first order.
    assert [f.text for f in ranked[1:4]] == [
        "Unrelated filler fact 2 about gardening",
        "Unrelated filler fact 1 about gardening",
        "Unrelated filler fact 0 about gardening",
    ]


def test_rank_facts_caps_at_top_k():
    assert len(rank_facts("anything", _filler(20), top_k=5)) == 5
    assert len(rank_facts("anything", _filler(20), top_k=0)) == 20


def test_old_relevant_fact_beats_many_newer_ones():
    """Before: newest facts filled the budget, so an old fact was lost."""
    facts = [Fact(text="User's dentist appointment is on Friday"), *_filler(200)]
    out = inject_context(
        "when is my dentist appointment",
        [Message(role=Role.USER, content="when is my dentist appointment")],
        None,
        config=ContextConfig(fact_top_k=8),
        facts=facts,
    )
    content = out[0].content
    assert "dentist appointment is on Friday" in content
    # Only a small top-k reaches the prompt, not the whole store.
    assert content.count("Unrelated filler fact") == 7


def test_fact_top_k_zero_keeps_legacy_behaviour():
    out = inject_context(
        "hello",
        [Message(role=Role.USER, content="hello")],
        None,
        config=ContextConfig(fact_top_k=0),
        facts=_filler(30),
    )
    assert out[0].content.count("Unrelated filler fact") == 30


def test_ranking_1000_facts_is_fast():
    facts = [
        Fact(text=f"fact {i} about project{i % 37} with friend{i}") for i in range(1000)
    ]
    started = time.perf_counter()
    ranked = rank_facts("what about project12 and friend500", facts, top_k=8)
    assert time.perf_counter() - started < 0.5
    assert ranked[0].text == "fact 500 about project19 with friend500" or any(
        "friend500" in f.text for f in ranked[:2]
    )


def test_recall_event_carries_node_ids(monkeypatch):
    bus = EventBus(record_history=True)
    import openjarvis.tools.storage.context as mod

    monkeypatch.setattr(mod, "get_event_bus", lambda: bus)
    fact = Fact(text="User drinks oat milk lattes")
    doc = RetrievalResult(content="Cafe menu: oat milk available", score=1.0)
    inject_context(
        "oat milk",
        [Message(role=Role.USER, content="oat milk")],
        _Fixed([doc]),
        facts=[fact],
    )
    (event,) = [e for e in bus.history if e.event_type == EventType.MEMORY_RETRIEVE]
    assert event.data["node_ids"] == [
        memory_node_id("fact", fact.text),
        memory_node_id("doc", doc.content),
    ]
    assert event.data["num_facts"] == 1 and event.data["num_results"] == 1
