"""Screen-look intent detection — a deterministic, pre-LLM check.

Runs the instant the transcript comes back (like `signoff.py`), before any model
call, and decides whether the person is asking the assistant to *look at the
screen*. It also decides which of two modes the turn is:

  * **describe** — "look at my screen", "what do you see": give a natural spoken
    description in the assistant's own voice.
  * **answer**   — "look at my screen and tell me X": skip the description and
    answer X directly, using the screenshot as context.

This is the normaliser the feature needs: many phrasings map to **one** action so
a command is never silently dropped. Pure text logic — no SDK imports, fully
unit-testable.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Imperative "look" commands. On their own -> describe. Followed by a real
# question/instruction -> answer that.
LOOK_TRIGGERS: tuple[str, ...] = (
    "look at my screen", "analyze my screen", "analyse my screen",
    "check my screen", "read my screen", "scan my screen", "see my screen",
    "look at the screen", "look at this screen", "capture my screen",
    "look at this", "check this out", "take a look", "look here",
)

# Question-shaped triggers. On their own -> describe. With a trailing specifier
# -> answer, using the whole utterance as the question.
QUESTION_TRIGGERS: tuple[str, ...] = (
    "what do you see", "what's on my screen", "what is on my screen",
    "what am i looking at", "what does this say", "what does it say",
    "what's on screen", "what do you make of this",
)

_ALL_TRIGGERS: tuple[str, ...] = LOOK_TRIGGERS + QUESTION_TRIGGERS

# Leading connectors to strip from the remainder before deciding if a real
# question/instruction follows the trigger.
_CONNECTORS: tuple[str, ...] = (
    "and", "then", "also", "so", "now", "please", "tell me", "and tell me",
    "then tell me", "can you", "could you", "and can you", "to", "for me",
    "real quick", "quickly",
)

# A remainder that starts with one of these reads as a question/instruction.
_QUESTION_WORDS: frozenset[str] = frozenset(
    {"what", "where", "which", "who", "whose", "when", "why", "how",
     "is", "are", "does", "do", "did", "can", "should", "any", "there"}
)
_INSTRUCTION_VERBS: frozenset[str] = frozenset(
    {"read", "find", "count", "summarize", "summarise", "check", "explain",
     "describe", "list", "tell", "get", "translate", "identify", "compare",
     "fix", "help", "show", "give", "look"}
)


@dataclass(frozen=True)
class ScreenIntent:
    is_request: bool
    question: str | None       # set = answer mode; None = describe mode
    reason: str


def _normalize(transcript: str) -> str:
    text = transcript.lower().replace("’", "'").strip()
    return re.sub(r"\s+", " ", text)


def _strip_connectors(text: str) -> str:
    changed = True
    while changed:
        changed = False
        for c in sorted(_CONNECTORS, key=len, reverse=True):
            if text == c:
                return ""
            if text.startswith(c + " "):
                text = text[len(c) + 1:].lstrip()
                changed = True
    return text


def _looks_like_question(remainder: str) -> bool:
    if not remainder:
        return False
    first = remainder.split(" ", 1)[0].strip("?.,")
    return first in _QUESTION_WORDS or first in _INSTRUCTION_VERBS or "?" in remainder


def evaluate(transcript: str) -> ScreenIntent:
    text = _normalize(transcript)
    if not text:
        return ScreenIntent(False, None, "empty transcript")

    # Find the earliest trigger present (prefer the longest match at that spot).
    hit: str | None = None
    hit_at = len(text) + 1
    for trig in _ALL_TRIGGERS:
        idx = text.find(trig)
        if idx != -1 and (idx < hit_at or (idx == hit_at and len(trig) > len(hit or ""))):
            hit, hit_at = trig, idx

    if hit is None:
        return ScreenIntent(False, None, "no screen trigger")

    remainder = _strip_connectors(text[hit_at + len(hit):].strip(" ,.?"))

    if hit in QUESTION_TRIGGERS:
        # The trigger is itself a question. Any real specifier after it -> answer
        # using the whole utterance; otherwise a plain description.
        if remainder:
            return ScreenIntent(True, transcript.strip(), f"question trigger + specifier ({hit!r})")
        return ScreenIntent(True, None, f"describe ({hit!r})")

    # Imperative "look" trigger: a trailing question/instruction -> answer it.
    if _looks_like_question(remainder):
        return ScreenIntent(True, remainder, f"look + question ({hit!r})")
    return ScreenIntent(True, None, f"describe ({hit!r})")
