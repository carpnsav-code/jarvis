"""Tier 5 — Know when to stop.

A deterministic, pre-LLM check: given the transcript of a turn, decide whether
the person is just signing off ("okay, thanks", "great, I'll do that") so the
assistant can stay silent and let the conversation end. Doing this *before* any
model call means a goodbye costs nothing — no tokens, no round trip.

Design principle: **conservative**. The failure modes are not symmetric.
  - Staying silent when the person wanted a reply  ->  reads as broken.  (BAD)
  - Replying to a borderline goodbye               ->  mild, old behavior. (OK)
So every layer here biases toward `should_end = False` (keep replying) whenever
there is any doubt.

Tuning is meant to be a one-line change: move a phrase between the buckets below
and re-run the tests. Capture real-world misses as new cases in
`tests/test_signoff.py`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# --- The buckets (tune these; everything else is mechanism) ---------------------

# Clear closings. Present + surviving the vetoes below = end the conversation.
STRONG_SIGNOFFS: tuple[str, ...] = (
    # departures
    "bye", "goodbye", "good bye", "see you", "see ya", "see you later",
    "talk to you later", "talk later", "catch you later", "later",
    "take care", "farewell", "good night", "goodnight",
    "have a good one", "have a good day", "have a good night",
    # completion
    "that's all", "thats all", "that is all", "that's it", "thats it",
    "that's everything", "thats everything", "that's all i need",
    "that's all i needed", "i'm good", "im good", "i'm all set", "im all set",
    "we're good", "were good", "all set", "all good", "nothing else",
    "i'm done", "im done", "we're done", "were done",
    # gratitude
    "thanks", "thank you", "thanks so much", "thank you so much",
    "thanks a lot", "thanks a ton", "many thanks", "thanks again",
    "appreciate it", "appreciate that", "much appreciated",
    # acknowledgment-close
    "will do", "sounds good", "sounds great", "got it", "right on",
    "roger that", "understood", "good to know",
)

# Bare positives. Only count as an ending in a *very short* utterance; in a
# longer sentence they are almost always leading into something ("great, so...").
BARE_POSITIVES: tuple[str, ...] = (
    "great", "cool", "perfect", "nice", "awesome", "excellent",
    "wonderful", "sweet", "gotcha", "lovely",
)

# Any of these means the person wants something back -> always reply.
REQUEST_MARKERS: tuple[str, ...] = (
    "can you", "could you", "would you", "will you", "can we", "could we",
    "how about", "what about", "one more thing", "another thing",
    "quick question", "one question", "let me", "hold on", "hang on",
    "wait", "actually", "by the way", "before you go", "real quick",
    "help me", "i need", "i want", "i'd like", "id like", "tell me",
    "show me", "give me", "what's", "whats", "how's", "hows",
)

# If a turn *starts* with one of these, it's a question -> reply.
LEADING_QUESTION_WORDS: frozenset[str] = frozenset(
    {"what", "why", "how", "when", "where", "who", "which", "whose", "is", "are",
     "do", "does", "did", "should", "could", "would", "can", "will", "was", "were"}
)

# Imperative verbs aimed at the assistant. A command is not a farewell...
COMMAND_VERBS: frozenset[str] = frozenset(
    {"send", "email", "call", "text", "add", "create", "schedule", "set",
     "remind", "book", "find", "search", "play", "pause", "turn", "open",
     "close", "make", "write", "delete", "cancel", "move", "start", "stop",
     "read", "check", "look", "tell", "show", "give", "get", "buy", "order",
     "update", "change", "remove", "list", "draft", "reply", "forward"}
)

# ...unless the person is committing to do it *themselves* ("I'll send that").
# Note the look-alike guards: "we'll"/"i'll" self-commit; "well"/"ill" do NOT.
SELF_COMMIT_MARKERS: tuple[str, ...] = (
    "i'll", "we'll", "i will", "we will", "i can", "i'm going to",
    "im going to", "i am going to", "i'll go", "let me handle",
    "i've got it", "ive got it", "i got it", "i'll take care",
    "i'll handle", "i'll do", "i can do",
)

# Discourse fillers — meaningless glue that never carries content.
FILLERS: frozenset[str] = frozenset(
    {"so", "and", "but", "um", "uh", "oh", "hmm", "like", "well", "right",
     "okay", "ok", "alright", "yeah", "yep", "yup", "mm", "mhm", "then",
     "just", "now"}
)

# Words that legitimately trail a "thanks" without being new content.
POLITE_TAIL: frozenset[str] = frozenset(
    {"for", "your", "the", "that", "this", "it", "much", "very", "really",
     "a", "lot", "ton", "bunch", "all", "help", "helping", "again", "of",
     "course", "no", "problem", "them", "everything", "anyway", "though",
     "i", "needed", "need", "appreciate"}
)

# A bare positive counts as an ending only if the whole utterance is at most
# this many words.
BARE_POSITIVE_MAX_WORDS: int = 3


@dataclass(frozen=True)
class SignoffResult:
    """Outcome of the check. `should_end` True = stay silent, wind down."""

    should_end: bool
    reason: str


def _normalize(transcript: str) -> list[str]:
    """Lowercase, unify apostrophes, and tokenize keeping apostrophes intact.

    Keeping apostrophes is what lets us tell "we'll" from "well" and "i'll"
    from "ill" — the look-alikes that bite this kind of logic.
    """
    text = transcript.lower().replace("’", "'").replace("`", "'")
    return re.findall(r"[a-z0-9]+(?:'[a-z]+)?", text)


def _padded(tokens: list[str]) -> str:
    """Space-padded token string for clean whole-phrase matching."""
    return " " + " ".join(tokens) + " "


def _contains(padded: str, phrase: str) -> bool:
    return f" {phrase} " in padded


def _matched_phrases(padded: str, phrases: tuple[str, ...]) -> list[str]:
    return [p for p in phrases if _contains(padded, p)]


def _residual_tokens(tokens: list[str], matched: list[str]) -> list[str]:
    """Tokens left after stripping recognized sign-off phrases, fillers, and
    polite tails. Non-empty means the person added new information ("okay, so
    the revenue is up") rather than just closing out.

    Used for both the continuation check and the command check, so a verb that
    is part of a closing ("all **set**") is never mistaken for a command.
    """
    remaining = _padded(tokens)
    # Remove matched phrases longest-first; re-pad so adjacent phrases both go.
    for phrase in sorted(matched, key=len, reverse=True):
        prev = None
        while prev != remaining:
            prev = remaining
            remaining = _padded(remaining.split())
            remaining = remaining.replace(f" {phrase} ", " ")
    return [
        t for t in remaining.split()
        if t not in FILLERS and t not in POLITE_TAIL
    ]


def evaluate(transcript: str, *, is_first_turn: bool = False) -> SignoffResult:
    """Decide whether this turn is a sign-off. Biased toward keeping the turn."""

    def reply(reason: str) -> SignoffResult:
        return SignoffResult(should_end=False, reason=reason)

    def end(reason: str) -> SignoffResult:
        return SignoffResult(should_end=True, reason=reason)

    # Never let the very first thing someone says be swallowed as a goodbye.
    if is_first_turn:
        return reply("first turn — never end")

    # Question mark = they want an answer.
    if "?" in transcript:
        return reply("question mark present")

    tokens = _normalize(transcript)
    if not tokens:
        return reply("empty transcript")

    padded = _padded(tokens)

    # Requests veto — a strong signal the person wants something back.
    request_hit = _matched_phrases(padded, REQUEST_MARKERS)
    if request_hit:
        return reply(f"request marker: {request_hit[0]!r}")

    # A sign-off phrase must actually be present.
    strong = _matched_phrases(padded, STRONG_SIGNOFFS)
    bare = _matched_phrases(padded, BARE_POSITIVES)
    if not strong and not bare:
        return reply("no sign-off phrase present")

    # A leading auxiliary/question word ("what...", "should...") usually means a
    # question — but only veto on it when there's no clear sign-off phrase, so we
    # don't trip over fixed closings that start with an auxiliary ("will do").
    if not strong and tokens[0] in LEADING_QUESTION_WORDS:
        return reply(f"leading question word: {tokens[0]!r}")

    self_commit = bool(_matched_phrases(padded, SELF_COMMIT_MARKERS))
    # Self-commitment ("I'll do that") is itself a strong ending signal and also
    # rescues the utterance from the command and continuation vetoes below.
    ending_is_strong = bool(strong) or self_commit

    residual = _residual_tokens(tokens, strong + bare)

    # Commands aimed at the assistant are not farewells — unless self-committing.
    # We look only at residual tokens so a verb inside a closing ("all set")
    # doesn't count.
    command_hit = [t for t in residual if t in COMMAND_VERBS]
    if command_hit and not self_commit:
        return reply(f"command verb: {command_hit[0]!r}")

    # Continuation: leading filler/positive followed by genuine new content.
    if not self_commit and residual:
        return reply("continuation — new information after opener")

    # A bare positive alone only ends things in a very short utterance.
    if bare and not ending_is_strong and len(tokens) > BARE_POSITIVE_MAX_WORDS:
        return reply("bare positive in a long utterance")

    matched_desc = (strong + bare)[0] if (strong or bare) else "self-commit"
    return end(f"sign-off: {matched_desc!r}")


def is_signoff(transcript: str, *, is_first_turn: bool = False) -> bool:
    """Convenience boolean wrapper around :func:`evaluate`."""
    return evaluate(transcript, is_first_turn=is_first_turn).should_end
