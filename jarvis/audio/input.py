"""Microphone capture -> async byte queue.

sounddevice runs its callback on a PortAudio thread, so we hand each block back
to the asyncio loop thread-safely. Audio is raw 16-bit PCM, mono, at the
configured sample rate — the same format Deepgram and Cartesia use, so nothing
is converted anywhere in the pipeline.
"""

from __future__ import annotations

import asyncio
from typing import AsyncIterator

import sounddevice as sd


class MicrophoneInput:
    def __init__(
        self,
        sample_rate: int,
        loop: asyncio.AbstractEventLoop,
        *,
        block_ms: int = 50,
    ) -> None:
        self._sample_rate = sample_rate
        self._loop = loop
        self._blocksize = int(sample_rate * block_ms / 1000)
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._stream: sd.RawInputStream | None = None

    def _callback(self, indata, _frames, _time, status) -> None:  # PortAudio thread
        if status:
            # Overflows etc. — not fatal; keep going.
            pass
        data = bytes(indata)
        self._loop.call_soon_threadsafe(self._queue.put_nowait, data)

    def start(self) -> None:
        self._stream = sd.RawInputStream(
            samplerate=self._sample_rate,
            channels=1,
            dtype="int16",
            blocksize=self._blocksize,
            callback=self._callback,
        )
        self._stream.start()

    async def chunks(self) -> AsyncIterator[bytes]:
        while True:
            yield await self._queue.get()

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
