"""Tests for the Chatterbox TTS backend and markdown-to-speech cleanup."""

from __future__ import annotations

import pytest

from openjarvis.speech._speakable import to_speakable


class TestSpeakable:
    def test_strips_emphasis_and_headings(self):
        assert to_speakable("# Status\n**All systems** are *online*") == (
            "Status. All systems are online."
        )

    def test_bullets_become_sentences(self):
        text = "Your briefing:\n- Weather is mild\n- Two meetings"
        assert to_speakable(text) == "Your briefing: Weather is mild. Two meetings."

    def test_links_code_and_urls(self):
        text = "See [the docs](https://x.y/z) or https://a.b/c and run `jarvis gui`."
        assert to_speakable(text) == "See the docs or the link and run jarvis gui."

    def test_code_fences_are_not_read_aloud(self):
        assert "print" not in to_speakable("Here:\n```python\nprint(1)\n```\nDone")

    def test_plain_text_unchanged(self):
        assert to_speakable("Certainly, sir.") == "Certainly, sir."

    def test_empty(self):
        assert to_speakable("") == ""
        assert to_speakable("**  **") == ""


class TestChatterboxBackend:
    def test_rejects_non_loopback_url(self, monkeypatch):
        from openjarvis.speech.chatterbox_tts import ChatterboxTTSBackend

        monkeypatch.setenv("CHATTERBOX_URL", "http://example.com:8004")
        with pytest.raises(ValueError):
            ChatterboxTTSBackend()

    @pytest.mark.parametrize(
        "url", ["http://127.0.0.1:8004", "http://localhost:9000/", "http://[::1]:8004"]
    )
    def test_accepts_loopback_urls(self, url):
        from openjarvis.speech.chatterbox_tts import ChatterboxTTSBackend

        ChatterboxTTSBackend(url=url)

    def test_health_false_when_server_down(self):
        from openjarvis.speech.chatterbox_tts import ChatterboxTTSBackend

        assert ChatterboxTTSBackend(url="http://127.0.0.1:9").health() is False

    def test_registered_and_first_in_order(self):
        # conftest clears registries between tests, so re-register explicitly
        # (same pattern as test_tts_backends.py).
        from openjarvis.core.registry import TTSRegistry
        from openjarvis.speech._tts_discovery import (
            TTS_BACKEND_ORDER,
            default_voice_for,
        )
        from openjarvis.speech.chatterbox_tts import ChatterboxTTSBackend

        TTSRegistry.register_value("chatterbox", ChatterboxTTSBackend)
        assert TTSRegistry.contains("chatterbox")
        assert TTS_BACKEND_ORDER[0] == "chatterbox"
        assert default_voice_for("chatterbox") == "butler"

    def test_synthesize_posts_to_local_server(self, monkeypatch):
        import httpx

        from openjarvis.speech.chatterbox_tts import ChatterboxTTSBackend

        sent = {}

        class Resp:
            content = b"RIFFwav"
            headers = {"X-Sample-Rate": "24000"}

            def raise_for_status(self):
                pass

        def fake_post(url, json, timeout):
            sent.update(url=url, json=json)
            return Resp()

        monkeypatch.setattr(httpx, "post", fake_post)
        result = ChatterboxTTSBackend(url="http://127.0.0.1:8004").synthesize(
            "Hello", voice_id="butler"
        )
        assert sent["url"] == "http://127.0.0.1:8004/synthesize"
        assert sent["json"]["text"] == "Hello"
        assert sent["json"]["voice"] == "butler"
        assert result.audio == b"RIFFwav"
        assert result.format == "wav"
