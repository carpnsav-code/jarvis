"""Cartesia streaming TTS adapter (Tier 4 — the mouth).

Cartesia's Sonic models are low-latency and stream audio as it's generated, so a
sentence starts playing almost immediately instead of after the whole reply is
rendered. We request **raw PCM (s16le) at the playback sample rate**, which means
there is no format/resample conversion between synthesis and the speaker — one
less source of dead air.

The orchestrator drives this sentence by sentence (see the SentenceChunker), so
the first sentence is spoken while the model is still writing the next.

The Cartesia Python SDK surface has moved across versions; this adapter targets
the async `tts.bytes(...)` streaming call. If your installed version names things
differently, adjust here — the rest of the app only sees the `TextToSpeech`
interface.
"""

from __future__ import annotations

from typing import AsyncIterator

from cartesia import AsyncCartesia

from .base import TextToSpeech


class CartesiaTTS(TextToSpeech):
    def __init__(
        self,
        api_key: str,
        *,
        model: str,
        sample_rate: int,
        voice_id: str = "",
    ) -> None:
        self._client = AsyncCartesia(api_key=api_key)
        self._model = model
        self._sample_rate = sample_rate
        self._voice_id = voice_id
        # Raw PCM at the playback rate -> no conversion before the speaker.
        self._output_format = {
            "container": "raw",
            "encoding": "pcm_s16le",
            "sample_rate": sample_rate,
        }

    async def synthesize(
        self, text: str, *, is_final: bool = False
    ) -> AsyncIterator[bytes]:
        kwargs = dict(
            model_id=self._model,
            transcript=text,
            output_format=self._output_format,
        )
        if self._voice_id:
            kwargs["voice"] = {"id": self._voice_id}

        async for chunk in self._client.tts.bytes(**kwargs):
            if chunk:
                yield chunk

    async def close(self) -> None:
        close = getattr(self._client, "close", None)
        if close is not None:
            await close()
