"""Speech-to-text interface (the ears).

Keeping this abstract means the rest of the app never depends on Deepgram
directly — swapping recognizers is an explicit new adapter + config change, never
a silent substitution. The event shape is deliberately provider-neutral and
carries exactly what Tier 2 endpointing needs: interim vs final, and the
recognizer's own `speech_final` / `utterance_end` end-of-turn signals.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import AsyncIterator, Literal

EventKind = Literal["interim", "final", "utterance_end"]


@dataclass(frozen=True)
class STTEvent:
    kind: EventKind
    text: str = ""
    # Only meaningful on "final": the recognizer's explicit end-of-utterance flag
    # (Deepgram calls it `speech_final`). Powers the Tier 2 fast path.
    speech_final: bool = False


class SpeechToText(abc.ABC):
    """Streaming recognizer. Audio in, transcript events out."""

    @abc.abstractmethod
    async def connect(self) -> None:
        """Open the streaming connection."""

    @abc.abstractmethod
    async def send(self, pcm: bytes) -> None:
        """Push a chunk of raw PCM audio (linear16, mono) for transcription."""

    @abc.abstractmethod
    def events(self) -> AsyncIterator[STTEvent]:
        """Async-iterate transcript events as they arrive."""

    @abc.abstractmethod
    async def close(self) -> None:
        """Close the connection and release resources."""
