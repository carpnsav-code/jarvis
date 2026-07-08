"""Text-to-speech interface (the mouth).

Abstract so the provider can be swapped explicitly, never silently. The contract
is a streaming one: given a sentence, yield playable audio **as it is
synthesized** so the first audio arrives almost immediately (Tier 4). Audio is
raw PCM at the app's playback sample rate — no conversion step between synthesis
and the speaker.
"""

from __future__ import annotations

import abc
from typing import AsyncIterator


class TextToSpeech(abc.ABC):
    @abc.abstractmethod
    def synthesize(self, text: str, *, is_final: bool = False) -> AsyncIterator[bytes]:
        """Yield raw PCM (s16le, mono, playback sample rate) for `text`.

        `is_final` marks the last sentence of a reply — providers with a
        streaming session can use it to flush/close cleanly.
        """

    async def close(self) -> None:  # pragma: no cover - optional hook
        """Release any persistent connection."""
