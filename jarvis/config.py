"""Central, env-driven configuration.

Every tunable that shapes latency or behavior lives here so tuning is a one-line
change (usually in `.env`), never a hunt through the code. Load order:
`.env` file (via python-dotenv) then real environment variables override it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # dotenv is optional at import time; real env vars still work.
    pass


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw in (None, ""):
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _str(name: str, default: str) -> str:
    raw = os.environ.get(name)
    return raw if raw not in (None, "") else default


@dataclass(frozen=True)
class Config:
    # --- Keys ---
    anthropic_api_key: str = ""
    deepgram_api_key: str = ""
    cartesia_api_key: str = ""

    # --- Brain (LLM) ---
    model: str = "claude-haiku-4-5"
    max_tokens: int = 300

    # --- Audio ---
    sample_rate: int = 16000

    # --- TTS (Cartesia) ---
    cartesia_voice_id: str = ""
    cartesia_model: str = "sonic-2"

    # --- STT (Deepgram) ---
    deepgram_model: str = "nova-3"
    deepgram_endpointing_ms: int = 300
    deepgram_utterance_end_ms: int = 1000

    # --- Tier 2: layered end-of-turn detection (milliseconds) ---
    fast_confirm_ms: int = 250
    silence_ceiling_ms: int = 1500

    # --- Tier 5: sign-off detection ---
    signoff_enabled: bool = True

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            anthropic_api_key=_str("ANTHROPIC_API_KEY", ""),
            deepgram_api_key=_str("DEEPGRAM_API_KEY", ""),
            cartesia_api_key=_str("CARTESIA_API_KEY", ""),
            model=_str("JARVIS_MODEL", "claude-haiku-4-5"),
            max_tokens=_int("JARVIS_MAX_TOKENS", 300),
            sample_rate=_int("JARVIS_SAMPLE_RATE", 16000),
            cartesia_voice_id=_str("CARTESIA_VOICE_ID", ""),
            cartesia_model=_str("CARTESIA_MODEL", "sonic-2"),
            deepgram_model=_str("DEEPGRAM_MODEL", "nova-3"),
            deepgram_endpointing_ms=_int("DEEPGRAM_ENDPOINTING_MS", 300),
            deepgram_utterance_end_ms=_int("DEEPGRAM_UTTERANCE_END_MS", 1000),
            fast_confirm_ms=_int("JARVIS_FAST_CONFIRM_MS", 250),
            silence_ceiling_ms=_int("JARVIS_SILENCE_CEILING_MS", 1500),
            signoff_enabled=_bool("JARVIS_SIGNOFF_ENABLED", True),
        )

    def require_keys(self) -> None:
        """Raise a clear error if a key needed for the live loop is missing."""
        missing = [
            name
            for name, val in (
                ("ANTHROPIC_API_KEY", self.anthropic_api_key),
                ("DEEPGRAM_API_KEY", self.deepgram_api_key),
                ("CARTESIA_API_KEY", self.cartesia_api_key),
            )
            if not val
        ]
        if missing:
            raise RuntimeError(
                "Missing required API keys: "
                + ", ".join(missing)
                + ". Copy .env.example to .env and fill them in."
            )
