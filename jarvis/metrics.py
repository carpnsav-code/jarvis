"""Tier 1 — Measure first.

You cannot smooth what you cannot see. `TurnTimer` stamps the five moments that
make up the wait on every turn and prints the breakdown, so the dominant cost is
always visible and every later improvement can be *shown* to move a number:

    stop speaking ─▶ transcript final ─▶ first LLM token ─▶ first TTS byte ─▶ first sound

The biggest gap is the thing to attack next — and it's often not where you'd
guess. Pure timing bookkeeping, no SDK imports.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable, Optional


@dataclass
class TurnTimer:
    """Records the five milestones of one turn and reports the gaps between them."""

    clock: Callable[[], float] = time.monotonic

    stopped_speaking_at: Optional[float] = None
    transcript_final_at: Optional[float] = None
    first_llm_token_at: Optional[float] = None
    first_tts_byte_at: Optional[float] = None
    first_sound_at: Optional[float] = None

    # Only the first call to each `mark_*` counts (first token, first byte, ...).
    _marks: set[str] = field(default_factory=set)

    def _mark(self, attr: str) -> None:
        if attr not in self._marks:
            setattr(self, attr, self.clock())
            self._marks.add(attr)

    def stamp(self, attr: str, ts: float) -> None:
        """Set a milestone to an explicit timestamp (first write wins).

        Used for `stopped_speaking_at`, which happened *before* the timer was
        created — we stamp it from when the last final transcript arrived so the
        Tier 2 endpointing wait shows up honestly in the breakdown.
        """
        if attr not in self._marks:
            setattr(self, attr, ts)
            self._marks.add(attr)

    def mark_stopped_speaking(self) -> None:
        self._mark("stopped_speaking_at")

    def mark_transcript_final(self) -> None:
        self._mark("transcript_final_at")

    def mark_first_llm_token(self) -> None:
        self._mark("first_llm_token_at")

    def mark_first_tts_byte(self) -> None:
        self._mark("first_tts_byte_at")

    def mark_first_sound(self) -> None:
        self._mark("first_sound_at")

    def _ms(self, a: Optional[float], b: Optional[float]) -> Optional[float]:
        if a is None or b is None:
            return None
        return (b - a) * 1000.0

    def segments_ms(self) -> dict[str, Optional[float]]:
        """The five component waits, in milliseconds (None if not reached)."""
        return {
            "stop -> transcript final": self._ms(
                self.stopped_speaking_at, self.transcript_final_at
            ),
            "transcript -> first token": self._ms(
                self.transcript_final_at, self.first_llm_token_at
            ),
            "first token -> first audio byte": self._ms(
                self.first_llm_token_at, self.first_tts_byte_at
            ),
            "first byte -> first sound": self._ms(
                self.first_tts_byte_at, self.first_sound_at
            ),
        }

    def total_ms(self) -> Optional[float]:
        """End-to-end: the number the person actually feels."""
        return self._ms(self.stopped_speaking_at, self.first_sound_at)

    def render(self) -> str:
        """A compact, human-readable breakdown for the console."""
        lines = ["  ── turn latency ──────────────────────────────"]
        segments = self.segments_ms()
        dominant_key = None
        dominant_val = -1.0
        for label, ms in segments.items():
            shown = f"{ms:7.0f} ms" if ms is not None else "     — "
            lines.append(f"    {label:<34} {shown}")
            if ms is not None and ms > dominant_val:
                dominant_val, dominant_key = ms, label
        total = self.total_ms()
        total_shown = f"{total:7.0f} ms" if total is not None else "     — "
        lines.append("  ────────────────────────────────────────────")
        lines.append(f"    {'stop speaking -> first sound':<34} {total_shown}")
        if dominant_key is not None:
            lines.append(f"    dominant cost: {dominant_key} ({dominant_val:.0f} ms)")
        return "\n".join(lines)
