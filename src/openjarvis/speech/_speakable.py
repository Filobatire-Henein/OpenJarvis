"""Turn chat-formatted (markdown) text into something natural to read aloud.

Assistant replies are written for the screen: ``**bold**``, ``# headings``,
bullet lists, links, code fences. Fed straight into a TTS engine those come out
as "asterisk asterisk" or as flat, list-like delivery, which is a large part of
why synthesized replies sound robotic. This module strips the formatting while
keeping the words and adding sentence breaks where list items and headings end.
"""

from __future__ import annotations

import re

_CODE_FENCE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE = re.compile(r"`([^`]*)`")
_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_BARE_URL = re.compile(r"https?://\S+")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s*(.+?)\s*#*\s*$", re.MULTILINE)
_BULLET = re.compile(r"^\s*(?:[-*+•]|\d+[.)])\s+", re.MULTILINE)
_QUOTE = re.compile(r"^\s*>\s?", re.MULTILINE)
_TABLE_RULE = re.compile(
    r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$", re.MULTILINE
)
_HR = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$", re.MULTILINE)
_EMPHASIS = re.compile(r"(\*\*|__|\*|_|~~)(?=\S)(.+?)(?<=\S)\1")
_HTML_TAG = re.compile(r"</?[a-zA-Z][^>]*>")
_EMOJI = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F2FF️]"
)


def to_speakable(text: str) -> str:
    """Return *text* with markdown removed, ready for a TTS engine."""
    if not text:
        return ""
    out = _CODE_FENCE.sub(" (code omitted) ", text)
    out = _IMAGE.sub(r"\1", out)
    out = _LINK.sub(r"\1", out)
    out = _BARE_URL.sub("the link", out)
    out = _INLINE_CODE.sub(r"\1", out)
    out = _TABLE_RULE.sub("", out)
    out = _HR.sub("", out)
    out = _HEADING.sub(r"\1.", out)
    out = _QUOTE.sub("", out)
    out = _BULLET.sub("", out)
    for _ in range(2):  # nested emphasis, e.g. ***bold italic***
        out = _EMPHASIS.sub(r"\2", out)
    out = _HTML_TAG.sub("", out)
    out = _EMOJI.sub("", out)
    out = out.replace("|", ", ")

    # Each remaining line is a sentence-ish unit: make sure it ends with a
    # pause so list items don't run together into one breathless sentence.
    lines = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        if line[-1] not in ".!?:;,":
            line += "."
        lines.append(line)
    out = " ".join(lines)
    out = re.sub(r"\s+([.,!?;:])", r"\1", out)
    out = re.sub(r"([.!?])\.+", r"\1", out)
    out = re.sub(r"\s{2,}", " ", out)
    return out.strip()


__all__ = ["to_speakable"]
