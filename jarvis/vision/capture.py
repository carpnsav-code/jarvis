"""Multi-monitor screen capture -> downscaled base64 PNG.

Uses `mss` to grab the actual display, which happens **regardless of our own
window state** — so background / minimized capture is inherent, no special
handling needed. Shots are downscaled before encoding: a full 4K screen is a huge
number of vision tokens and a real latency hit, and this is a voice loop where
latency is the whole point.

`_downscale` and `to_base64` are split out so they're unit-testable with a
synthetic `PIL.Image` — no physical display required.
"""

from __future__ import annotations

import base64
import io

from PIL import Image

_DEFAULT_MAX_EDGE = 1280


def _downscale(img: Image.Image, max_edge: int) -> Image.Image:
    """Shrink so the long edge is at most `max_edge`, preserving aspect ratio.

    Never upscales — a small window stays its own size.
    """
    if max_edge <= 0:
        raise ValueError(f"max_edge must be positive, got {max_edge}")
    w, h = img.size
    longest = max(w, h)
    if longest <= max_edge:
        return img
    scale = max_edge / longest
    new_size = (max(1, round(w * scale)), max(1, round(h * scale)))
    return img.resize(new_size, Image.LANCZOS)


def to_base64(png_bytes: bytes) -> str:
    """Base64-encode PNG bytes for a Claude image content block."""
    return base64.b64encode(png_bytes).decode("ascii")


def _encode_png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


def capture_all_monitors_b64(max_edge: int = _DEFAULT_MAX_EDGE) -> list[str]:
    """Capture every monitor and return a list of downscaled base64 PNG strings.

    One entry per physical monitor (falling back to the virtual union if the
    per-monitor list is empty). Imported lazily so the rest of the app — and the
    test suite — never needs `mss` or a display just to load.
    """
    import mss  # local import: only needed at capture time

    shots: list[str] = []
    with mss.mss() as sct:
        monitors = sct.monitors[1:] or [sct.monitors[0]]
        for mon in monitors:
            raw = sct.grab(mon)
            img = Image.frombytes("RGB", raw.size, raw.rgb)
            img = _downscale(img, max_edge)
            shots.append(to_base64(_encode_png(img)))
    return shots
