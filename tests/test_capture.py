"""Tests for the display-independent parts of screen capture.

`_downscale` and `to_base64` run against a synthetic PIL image — no monitor,
no `mss`, no API keys.
"""

import base64

import pytest
from PIL import Image

from jarvis.vision.capture import _downscale, to_base64, _encode_png


def test_downscale_caps_the_long_edge_and_keeps_aspect():
    img = Image.new("RGB", (4000, 2000))
    out = _downscale(img, 1280)
    assert max(out.size) == 1280
    # 4000:2000 == 2:1 aspect preserved
    assert out.size == (1280, 640)


def test_downscale_does_not_upscale():
    img = Image.new("RGB", (800, 600))
    out = _downscale(img, 1280)
    assert out.size == (800, 600)


def test_downscale_handles_portrait():
    img = Image.new("RGB", (1000, 3000))
    out = _downscale(img, 1500)
    assert max(out.size) == 1500
    assert out.size == (500, 1500)


def test_downscale_rejects_bad_max_edge():
    with pytest.raises(ValueError):
        _downscale(Image.new("RGB", (10, 10)), 0)


def test_to_base64_round_trips_png_bytes():
    img = Image.new("RGB", (32, 32), (10, 20, 30))
    png = _encode_png(img)
    b64 = to_base64(png)
    assert isinstance(b64, str)
    assert base64.b64decode(b64) == png
    # decoded PNG re-opens to the same size
    from io import BytesIO
    assert Image.open(BytesIO(base64.b64decode(b64))).size == (32, 32)
