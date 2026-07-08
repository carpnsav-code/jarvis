"""Tier 3/4 — Overlap thinking and speaking.

Buffers a stream of LLM text tokens and emits *sentence-sized* pieces the moment
each one is complete, so the first sentence can be on its way to text-to-speech
while the model is still writing the second. This is what turns "wait for the
whole reply, then talk" into "start talking almost immediately."

"Hold one ahead": we keep the most recently completed sentence buffered just
long enough to know whether another is coming. That lets the consumer mark the
*final* sentence correctly (some TTS streaming endpoints want a "this is the
last one" flag) without an awkward extra round trip. Callers who don't need the
final flag can ignore it.

No SDK imports — pure text logic, fully unit-testable.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterator

# Sentence-final punctuation. We split *after* one of these when it's followed by
# whitespace (or end of buffer at flush), which avoids splitting on the dot in
# abbreviations and decimals mid-stream.
_SENTENCE_END = re.compile(
    r"""
    (?<=[.!?])        # a sentence-ending mark
    (?=\s)            # followed by whitespace
    """,
    re.VERBOSE,
)

# Common abbreviations whose trailing period must NOT end a sentence.
_ABBREVIATIONS = frozenset(
    {"mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "st.", "mt.",
     "vs.", "etc.", "e.g.", "i.e.", "a.m.", "p.m.", "u.s.", "u.k.",
     "inc.", "ltd.", "co.", "no.", "fig.", "approx.", "dept.", "gov."}
)

# Minimum characters before we're willing to emit a sentence. Guards against
# spitting out a lone "3." from "3.14" or a single-letter false positive.
_MIN_SENTENCE_CHARS = 2


@dataclass(frozen=True)
class Sentence:
    """A completed sentence ready to synthesize."""

    text: str
    is_final: bool  # True only for the last sentence of the whole reply.


def _looks_like_abbreviation(chunk: str) -> bool:
    """True if `chunk` ends with a known abbreviation (so don't split here)."""
    tail = chunk.rsplit(maxsplit=1)[-1].lower() if chunk.split() else ""
    return tail in _ABBREVIATIONS


class SentenceChunker:
    """Feed tokens in with :meth:`push`; get completed sentences out.

    Emission is delayed by one sentence (hold-one-ahead): pushing text that
    completes sentence N causes sentence N-1 to be emitted (not final). Call
    :meth:`flush` at end-of-stream to release the last held sentence, marked
    final.
    """

    def __init__(self) -> None:
        self._buffer = ""
        self._held: str | None = None  # the completed-but-not-yet-emitted sentence

    def push(self, token: str) -> Iterator[Sentence]:
        """Add streamed text; yield any sentences that became safe to emit."""
        self._buffer += token
        while True:
            candidate = self._take_complete_sentence()
            if candidate is None:
                break
            # Release the previously held sentence now that a newer one exists.
            if self._held is not None:
                yield Sentence(text=self._held, is_final=False)
            self._held = candidate

    def flush(self) -> Iterator[Sentence]:
        """End of stream: emit whatever remains, marking the true last sentence."""
        tail = self._buffer.strip()
        self._buffer = ""
        pieces: list[str] = []
        if self._held is not None:
            pieces.append(self._held)
            self._held = None
        if len(tail) >= _MIN_SENTENCE_CHARS:
            pieces.append(tail)
        elif tail and pieces:
            # A stray fragment shorter than the minimum: glue it onto the last
            # real sentence rather than dropping it.
            pieces[-1] = f"{pieces[-1]} {tail}".strip()
        for i, piece in enumerate(pieces):
            yield Sentence(text=piece, is_final=(i == len(pieces) - 1))

    def _take_complete_sentence(self) -> str | None:
        """Pop the first complete sentence from the buffer, or None if none yet."""
        for match in _SENTENCE_END.finditer(self._buffer):
            split_at = match.start()
            candidate = self._buffer[:split_at].strip()
            if len(candidate) < _MIN_SENTENCE_CHARS:
                continue
            if _looks_like_abbreviation(candidate):
                continue
            self._buffer = self._buffer[split_at:].lstrip()
            return candidate
        return None
