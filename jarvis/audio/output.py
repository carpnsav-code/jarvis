"""Streaming speaker playback with barge-in support (Tier 4 + Tier 6).

A persistent output stream drains an internal PCM buffer, so we can `enqueue`
audio as it streams out of TTS and it plays continuously. `interrupt()` empties
the buffer instantly — that's barge-in: the moment the person starts talking, we
stop speaking and listen.

`arm_first_sound` registers a one-shot callback fired when real audio first hits
the speaker for a turn, which is the true "first sound" moment for the Tier 1
latency breakdown.
"""

from __future__ import annotations

import threading
from typing import Callable, Optional

import sounddevice as sd


class SpeakerOutput:
    def __init__(self, sample_rate: int) -> None:
        self._sample_rate = sample_rate
        self._buf = bytearray()
        self._lock = threading.Lock()
        self._stream: sd.RawOutputStream | None = None
        self._on_first_sound: Optional[Callable[[], None]] = None

    def _callback(self, outdata, frames, _time, status) -> None:  # PortAudio thread
        needed = frames * 2  # int16 mono = 2 bytes/frame
        fire: Optional[Callable[[], None]] = None
        with self._lock:
            if self._buf:
                if self._on_first_sound is not None:
                    fire = self._on_first_sound
                    self._on_first_sound = None
                take = self._buf[:needed]
                del self._buf[:needed]
                chunk = bytes(take)
                if len(chunk) < needed:
                    chunk += b"\x00" * (needed - len(chunk))
                outdata[:] = chunk
            else:
                outdata[:] = b"\x00" * needed
        if fire is not None:
            fire()  # only stamps a timestamp; cheap and lock-free

    def start(self) -> None:
        self._stream = sd.RawOutputStream(
            samplerate=self._sample_rate,
            channels=1,
            dtype="int16",
            callback=self._callback,
        )
        self._stream.start()

    def enqueue(self, pcm: bytes) -> None:
        with self._lock:
            self._buf.extend(pcm)

    def arm_first_sound(self, callback: Callable[[], None]) -> None:
        """Register a one-shot fired when the next audio starts playing."""
        with self._lock:
            self._on_first_sound = callback

    def interrupt(self) -> None:
        """Drop all buffered audio immediately (barge-in)."""
        with self._lock:
            self._buf.clear()
            self._on_first_sound = None

    def is_playing(self) -> bool:
        with self._lock:
            return len(self._buf) > 0

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
