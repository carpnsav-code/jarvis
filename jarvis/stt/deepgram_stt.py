"""Deepgram streaming STT adapter (Tier B — the ears).

Audio is **streamed continuously** to Deepgram (never recorded-then-sent), which
is the single biggest factor in end-of-turn lag. We lean on Deepgram's own
end-of-turn intelligence:

  * `endpointing` + `speech_final` on a final result  -> Tier 2 fast path
  * `UtteranceEnd` (`vad_events` / `utterance_end_ms`) -> Tier 2 slow path

Both are surfaced as provider-neutral :class:`STTEvent`s the orchestrator feeds
straight into :class:`~jarvis.turn.endpointing.EndOfTurnDetector`.

Note: the Deepgram Python SDK's handler signatures have shifted across 3.x
releases. This adapter reads results defensively so a minor SDK bump doesn't
break the loop; if Deepgram changes an event name, adjust the handler wiring
here — nothing else in the app needs to know.
"""

from __future__ import annotations

import asyncio
from typing import AsyncIterator

from deepgram import (
    DeepgramClient,
    LiveOptions,
    LiveTranscriptionEvents,
)

from .base import STTEvent, SpeechToText

_SENTINEL = object()  # signals the end of the event stream


class DeepgramSTT(SpeechToText):
    def __init__(
        self,
        api_key: str,
        *,
        model: str,
        sample_rate: int,
        endpointing_ms: int,
        utterance_end_ms: int,
    ) -> None:
        self._client = DeepgramClient(api_key)
        self._model = model
        self._sample_rate = sample_rate
        self._endpointing_ms = endpointing_ms
        self._utterance_end_ms = utterance_end_ms
        self._conn = None
        self._queue: asyncio.Queue = asyncio.Queue()
        self._loop: asyncio.AbstractEventLoop | None = None

    async def connect(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._conn = self._client.listen.asyncwebsocket.v("1")

        async def on_transcript(_conn, result, **_kwargs) -> None:
            try:
                alt = result.channel.alternatives[0]
                text = alt.transcript or ""
            except (AttributeError, IndexError):
                return
            if not text:
                return
            if getattr(result, "is_final", False):
                await self._queue.put(
                    STTEvent(
                        kind="final",
                        text=text,
                        speech_final=bool(getattr(result, "speech_final", False)),
                    )
                )
            else:
                await self._queue.put(STTEvent(kind="interim", text=text))

        async def on_utterance_end(_conn, _result, **_kwargs) -> None:
            await self._queue.put(STTEvent(kind="utterance_end"))

        self._conn.on(LiveTranscriptionEvents.Transcript, on_transcript)
        self._conn.on(LiveTranscriptionEvents.UtteranceEnd, on_utterance_end)

        options = LiveOptions(
            model=self._model,
            language="en",
            encoding="linear16",
            sample_rate=self._sample_rate,
            channels=1,
            interim_results=True,       # stream partials so we react as they talk
            punctuate=True,
            smart_format=True,
            endpointing=self._endpointing_ms,        # -> speech_final (fast path)
            utterance_end_ms=self._utterance_end_ms,  # -> UtteranceEnd (slow path)
            vad_events=True,
        )
        await self._conn.start(options)

    async def send(self, pcm: bytes) -> None:
        if self._conn is not None:
            await self._conn.send(pcm)

    async def events(self) -> AsyncIterator[STTEvent]:
        while True:
            item = await self._queue.get()
            if item is _SENTINEL:
                return
            yield item

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.finish()
            self._conn = None
        await self._queue.put(_SENTINEL)
