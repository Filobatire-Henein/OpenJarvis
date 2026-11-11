"""Chatterbox text-to-speech backend (local, offline).

Chatterbox (Resemble AI, MIT) produces far more natural, human-sounding speech
than small TTS models, but it pins older torch/transformers versions that
conflict with OpenJarvis's own dependencies. So it runs in its own virtualenv
as a tiny HTTP server on loopback (``scripts/voice/chatterbox_server.py``) and
this backend talks to it.

Privacy: the server URL is restricted to loopback addresses, so enabling this
backend can never send reply text off the machine.

Environment:
    CHATTERBOX_URL          default ``http://127.0.0.1:8004``
    CHATTERBOX_EXAGGERATION emotion/intensity, 0.25-2.0 (default 0.5)
    CHATTERBOX_CFG_WEIGHT   pacing/adherence, 0.0-1.0 (default 0.5; lower =
                            slower, more deliberate delivery)
"""

from __future__ import annotations

import os
from typing import List
from urllib.parse import urlparse

import httpx

from openjarvis.core.registry import TTSRegistry
from openjarvis.speech.tts import TTSBackend, TTSResult

_DEFAULT_URL = "http://127.0.0.1:8004"
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}
DEFAULT_VOICE = "butler"


def _require_loopback(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or parsed.hostname not in {
        h.strip("[]") for h in _LOOPBACK_HOSTS
    }:
        raise ValueError(
            f"CHATTERBOX_URL must point at this machine (loopback), got {url!r}"
        )
    return url.rstrip("/")


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


@TTSRegistry.register("chatterbox")
class ChatterboxTTSBackend(TTSBackend):
    """Local Chatterbox server — natural, expressive, offline speech."""

    backend_id = "chatterbox"

    def __init__(self, *, url: str = "") -> None:
        self._url = _require_loopback(
            url or os.environ.get("CHATTERBOX_URL", "") or _DEFAULT_URL
        )
        self._exaggeration = _env_float("CHATTERBOX_EXAGGERATION", 0.5)
        self._cfg_weight = _env_float("CHATTERBOX_CFG_WEIGHT", 0.5)

    def synthesize(
        self,
        text: str,
        *,
        voice_id: str = "",
        speed: float = 1.0,
        output_format: str = "wav",
    ) -> TTSResult:
        # Chatterbox has no speed knob; cfg_weight is the closest control
        # (lower = slower). Nudge it when a slower voice is requested.
        cfg = self._cfg_weight
        if speed < 1.0:
            cfg = max(0.0, cfg - (1.0 - speed))
        voice = voice_id or DEFAULT_VOICE
        resp = httpx.post(
            f"{self._url}/synthesize",
            json={
                "text": text,
                "voice": voice,
                "exaggeration": self._exaggeration,
                "cfg_weight": cfg,
            },
            timeout=180.0,
        )
        resp.raise_for_status()
        return TTSResult(
            audio=resp.content,
            format="wav",
            voice_id=voice,
            sample_rate=int(resp.headers.get("X-Sample-Rate", "24000")),
            metadata={"backend": "chatterbox"},
        )

    def available_voices(self) -> List[str]:
        try:
            resp = httpx.get(f"{self._url}/health", timeout=2.0)
            resp.raise_for_status()
            return list(resp.json().get("voices", []))
        except Exception:
            return []

    def health(self) -> bool:
        try:
            resp = httpx.get(f"{self._url}/health", timeout=1.5)
            return resp.status_code == 200 and resp.json().get("ready", False)
        except Exception:
            return False


__all__ = ["ChatterboxTTSBackend", "DEFAULT_VOICE"]
