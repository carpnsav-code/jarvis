"""Tier 2 — Stop waiting so long to start.

Deciding "the person is done talking" with a single fixed silence timeout is
what makes assistants feel laggy: the timeout has to be long enough for the
slowest case, so every turn pays that cost. This is a **layered** detector:

  * Fast path — when the recognizer gives an explicit end-of-utterance signal
    (Deepgram's ``speech_final``), we only need a short confirm window
    (a few hundred ms) before taking the turn.
  * Slow path — when it doesn't (noisy room, trailing off, mid-thought), we
    fall back to the recognizer's ``UtteranceEnd`` or a longer silence ceiling
    so we never cut people off.

It is **check-and-go**, never a blind ``sleep``: the orchestrator polls
:meth:`should_take_turn` and moves the instant it returns True, with the
ceiling guaranteeing we never wait longer than the old fixed delay.

Pure logic with an injectable clock — no SDK imports, fully unit-testable.
"""

from __future__ import annotations

import time
from typing import Callable, Optional


class EndOfTurnDetector:
    """Accumulates STT events and decides when to take the turn.

    Feed it events as they arrive (:meth:`on_interim`, :meth:`on_final`,
    :meth:`on_utterance_end`) and poll :meth:`should_take_turn`. Call
    :meth:`take_transcript` to consume the finalized text and reset.
    """

    def __init__(
        self,
        fast_confirm_ms: int,
        silence_ceiling_ms: int,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._fast_confirm = fast_confirm_ms / 1000.0
        self._ceiling = silence_ceiling_ms / 1000.0
        self._clock = clock
        self.reset()

    def reset(self) -> None:
        self._segments: list[str] = []
        self._speaking = False            # an interim arrived after the last final
        self._last_final_at: Optional[float] = None
        self._speech_final_at: Optional[float] = None
        self._utterance_ended = False

    # --- event intake ---------------------------------------------------------

    def on_interim(self, text: str) -> None:
        """A partial (still-in-progress) transcript. The person is still talking."""
        if text.strip():
            self._speaking = True
            # New speech invalidates any pending fast-path confirm.
            self._speech_final_at = None
            self._utterance_ended = False

    def on_final(self, text: str, *, speech_final: bool) -> None:
        """A finalized phrase. ``speech_final`` is the recognizer's endpoint flag."""
        cleaned = text.strip()
        if cleaned:
            self._segments.append(cleaned)
        self._speaking = False
        self._last_final_at = self._clock()
        # Fast path arms only when the recognizer itself says the utterance ended.
        self._speech_final_at = self._last_final_at if speech_final else None

    def on_utterance_end(self) -> None:
        """Deepgram ``UtteranceEnd`` — the slow-path "they're done" signal."""
        if self._segments:
            self._utterance_ended = True

    # --- decision -------------------------------------------------------------

    @property
    def has_speech(self) -> bool:
        return bool(self._segments)

    def should_take_turn(self, now: Optional[float] = None) -> bool:
        """True the instant we're confident the person has finished."""
        if not self._segments or self._speaking:
            return False
        now = self._clock() if now is None else now

        # Fast path: recognizer flagged the end; a brief confirm window is enough.
        if self._speech_final_at is not None:
            if now - self._speech_final_at >= self._fast_confirm:
                return True

        # Slow path: recognizer's own utterance-end signal.
        if self._utterance_ended:
            return True

        # Ceiling: never wait longer than the old fixed delay.
        if self._last_final_at is not None:
            if now - self._last_final_at >= self._ceiling:
                return True

        return False

    def take_transcript(self) -> str:
        """Return the accumulated transcript and reset for the next turn."""
        transcript = " ".join(self._segments).strip()
        self.reset()
        return transcript
