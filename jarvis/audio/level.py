"""Audio level (RMS) — drives the dashboard's spectrum and signal gauge.

Pure numeric helper (numpy only), so it's unit-testable without any device.
Used for both the microphone input and the synthesized TTS output so the HUD
spectrum reacts whether you're talking or Jarvis is.
"""

from __future__ import annotations

import numpy as np


def rms_level(pcm_s16le: bytes, gain: float = 3.5) -> float:
    """Root-mean-square loudness of a 16-bit mono PCM buffer, as 0.0–1.0.

    `gain` scales quiet speech up into a visible range; the result is clamped.
    """
    if not pcm_s16le:
        return 0.0
    if len(pcm_s16le) % 2:  # frombuffer needs whole int16 samples
        pcm_s16le = pcm_s16le[:-1]
    samples = np.frombuffer(pcm_s16le, dtype=np.int16)
    if samples.size == 0:
        return 0.0
    x = samples.astype(np.float32) / 32768.0
    rms = float(np.sqrt(np.mean(x * x)))
    return max(0.0, min(1.0, rms * gain))
