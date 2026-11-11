#!/usr/bin/env python3
"""Local Chatterbox TTS server for OpenJarvis (offline, loopback only).

Runs in its OWN virtualenv because chatterbox-tts pins torch/transformers
versions that conflict with OpenJarvis:

    uv venv --python 3.11 ~/.openjarvis/chatterbox-venv
    uv pip install --python ~/.openjarvis/chatterbox-venv/bin/python chatterbox-tts
    ~/.openjarvis/chatterbox-venv/bin/python scripts/voice/chatterbox_server.py

Then set ``[speech] tts_backend = "chatterbox"`` in ~/.openjarvis/config.toml.

Voices are reference clips in ~/.openjarvis/voices/<name>.wav (5-15 s of clean
speech). Only use recordings of yourself, people who consented, or synthetic
voices — never clone someone without their permission.

API (stdlib HTTP, no extra deps):
    GET  /health      -> {"ready": bool, "voices": [...], "device": "..."}
    POST /synthesize  {"text", "voice", "exaggeration", "cfg_weight"} -> audio/wav
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s chatterbox %(message)s")
log = logging.getLogger("chatterbox")

LOOPBACK = {"127.0.0.1", "localhost", "::1"}
MAX_TEXT = 4000
# Chatterbox degrades on long inputs; synthesize sentence groups of this size.
CHUNK_CHARS = 280

STATE: dict = {
    "model": None, "device": "", "error": "", "variant": "turbo", "voice": None,
}
LOCK = threading.Lock()


def pick_device() -> str:
    import torch

    if STATE.get("device_pref", "auto") != "auto":
        return STATE["device_pref"]
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def load_model() -> None:
    import torch

    if STATE["variant"] == "turbo":
        # Turbo: 350M params, one-step decoder — several times faster than
        # the original, and supports tags like [chuckle] / [sigh].
        from chatterbox.tts_turbo import ChatterboxTurboTTS as ChatterboxTTS
    else:
        from chatterbox.tts import ChatterboxTTS

    device = pick_device()
    # Checkpoints were saved on CUDA; map them onto whatever we have.
    original_load = torch.load

    def _load(*args, **kwargs):
        kwargs.setdefault("map_location", torch.device(device))
        return original_load(*args, **kwargs)

    torch.load = _load
    try:
        STATE["model"] = ChatterboxTTS.from_pretrained(device=device)
        STATE["device"] = device
    except Exception as exc:  # fall back to CPU if MPS ops are missing
        if device != "cpu":
            log.warning("load on %s failed (%s); retrying on cpu", device, exc)
            STATE["model"] = ChatterboxTTS.from_pretrained(device="cpu")
            STATE["device"] = "cpu"
        else:
            raise
    finally:
        torch.load = original_load
    log.info("model ready on %s", STATE["device"])


def split_text(text: str) -> list[str]:
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    chunks, cur = [], ""
    for s in sentences:
        if cur and len(cur) + len(s) + 1 > CHUNK_CHARS:
            chunks.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        chunks.append(cur)
    return chunks or [text]


def synthesize(
    text: str, voice_path: Path | None, exaggeration: float, cfg: float
) -> bytes:
    import torch
    import torchaudio

    model = STATE["model"]
    turbo = STATE["variant"] == "turbo"
    pieces = []
    gap = torch.zeros(1, int(model.sr * 0.18))  # short natural pause
    with LOCK, torch.inference_mode():
        # Encode the reference voice once and reuse it: re-reading the clip on
        # every request costs seconds per reply.
        key = (str(voice_path), exaggeration)
        if voice_path is not None and STATE["voice"] != key:
            model.prepare_conditionals(
                str(voice_path), exaggeration=0.0 if turbo else exaggeration
            )
            STATE["voice"] = key
        for i, chunk in enumerate(split_text(text)):
            kwargs = {} if turbo else {"exaggeration": exaggeration, "cfg_weight": cfg}
            wav = model.generate(chunk, **kwargs).cpu()
            if i:
                pieces.append(gap)
            pieces.append(wav)
    audio = torch.cat(pieces, dim=-1)
    buf = io.BytesIO()
    torchaudio.save(buf, audio, model.sr, format="wav")
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    voices_dir: Path = Path.home() / ".openjarvis" / "voices"

    def log_message(self, fmt, *args):  # quieter default logging
        log.debug(fmt, *args)

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _voices(self) -> list[str]:
        return sorted(p.stem for p in self.voices_dir.glob("*.wav"))

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            self._json(200, {
                "ready": STATE["model"] is not None,
                "device": STATE["device"],
                "model": STATE["variant"],
                "voices": self._voices(),
                "error": STATE["error"],
            })
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/synthesize":
            return self._json(404, {"error": "not found"})
        if STATE["model"] is None:
            return self._json(503, {"error": "model loading"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(min(length, 64_000)) or b"{}")
            text = str(req.get("text", "")).strip()[:MAX_TEXT]
            if not text:
                return self._json(400, {"error": "missing text"})
            name = re.sub(r"[^A-Za-z0-9_-]", "", str(req.get("voice", "")))
            path = self.voices_dir / f"{name}.wav" if name else None
            if path is not None and not path.is_file():
                path = None  # unknown voice -> Chatterbox built-in voice
            exaggeration = min(2.0, max(0.25, float(req.get("exaggeration", 0.5))))
            cfg = min(1.0, max(0.0, float(req.get("cfg_weight", 0.5))))
            audio = synthesize(text, path, exaggeration, cfg)
        except Exception as exc:
            log.exception("synthesis failed")
            return self._json(500, {"error": str(exc)[:200]})
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("X-Sample-Rate", str(STATE["model"].sr))
        self.end_headers()
        self.wfile.write(audio)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8004)
    ap.add_argument("--voices-dir", default=str(Handler.voices_dir))
    ap.add_argument(
        "--model", choices=("turbo", "standard"), default="turbo",
        help="turbo = fast (default); standard = slower, supports exaggeration",
    )
    ap.add_argument("--device", choices=("auto", "mps", "cpu", "cuda"), default="auto")
    args = ap.parse_args()
    if args.host not in LOOPBACK:
        raise SystemExit("Refusing to listen on a non-loopback address.")
    STATE["variant"] = args.model
    STATE["device_pref"] = args.device
    Handler.voices_dir = Path(args.voices_dir).expanduser()
    Handler.voices_dir.mkdir(parents=True, exist_ok=True)

    def _boot():
        try:
            load_model()
        except Exception as exc:
            STATE["error"] = str(exc)[:300]
            log.exception("model failed to load")

    threading.Thread(target=_boot, daemon=True).start()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log.info(
        "listening on http://%s:%d (voices: %s)",
        args.host, args.port, Handler.voices_dir,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
