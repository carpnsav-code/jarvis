"""Tests for the audio RMS level helper (drives the HUD spectrum)."""

import struct

from pytest import approx

from jarvis.audio.level import rms_level


def _pcm(samples):
    return struct.pack("<" + "h" * len(samples), *samples)


def test_silence_is_zero():
    assert rms_level(_pcm([0] * 100)) == 0.0
    assert rms_level(b"") == 0.0


def test_full_scale_saturates_to_one():
    # A loud constant tone at full scale, even before gain, is RMS ~1.0.
    loud = _pcm([32767, -32768] * 200)
    assert rms_level(loud, gain=1.0) == approx(1.0, abs=0.01)


def test_output_is_clamped_by_gain():
    mid = _pcm([8000, -8000] * 200)  # ~0.24 RMS
    assert rms_level(mid, gain=1.0) == approx(0.244, abs=0.02)
    assert rms_level(mid, gain=100.0) == 1.0  # clamped, never exceeds 1


def test_odd_length_buffer_does_not_crash():
    # A stray trailing byte (half a sample) must be tolerated.
    assert 0.0 <= rms_level(_pcm([5000, -5000]) + b"\x01") <= 1.0
