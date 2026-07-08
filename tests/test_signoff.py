"""The do-not-break suite for Tier 5 sign-off detection.

Two asymmetric obligations:
  * Clear goodbyes must END (stay silent).
  * Anything a person might want a reply to must KEEP REPLYING — questions,
    commands, continuations, and the look-alikes that trip naive logic.

When a real-world miss is found, add the exact phrase here first, then adjust
the word lists in `jarvis/turn/signoff.py`. That keeps the behavior documented
and prevents silent regressions.
"""

import pytest

from jarvis.turn.signoff import evaluate, is_signoff


# --- Should END: clear sign-offs -------------------------------------------------

SIGNOFFS = [
    "okay, thanks",
    "thanks",
    "thank you",
    "thank you so much",
    "thanks a lot",
    "great, thanks",
    "perfect, thanks",
    "sounds good",
    "sounds great",
    "will do",              # starts with the auxiliary "will" — must not be vetoed
    "got it",
    "understood",
    "right on",
    "bye",
    "goodbye",
    "see you later",
    "talk to you later",
    "good night",
    "that's all",
    "that's it",
    "i'm good",
    "we're good",
    "all set",
    "cool",                 # bare positive in a very short utterance
    "great",
    "perfect",
    "great, I'll do that",  # self-commitment
    "great, I'll send that email",  # self-commit rescues the command verb
    "got it, I'll take care of it",
    "we'll talk later",     # "we'll" is a self-commit look-alike (not "well")
    "well, that's all",     # "well" is a filler look-alike (not "we'll")
    "appreciate it",
    "much appreciated",
]


@pytest.mark.parametrize("text", SIGNOFFS)
def test_signoffs_end_the_conversation(text):
    result = evaluate(text, is_first_turn=False)
    assert result.should_end is True, f"expected END for {text!r} ({result.reason})"


# --- Should KEEP REPLYING: questions, requests, commands, continuations ----------

KEEP_REPLYING = [
    # questions
    "thanks, can you also check the weather?",
    "sounds good, but how does that work?",
    "what's the forecast",
    "how about tomorrow",
    # requests / "one more thing"
    "thanks, one more thing",
    "great, actually one more question",
    "wait, thanks",
    "hold on",
    # commands aimed at the assistant
    "great, send that email",
    "perfect, add it to my calendar",
    "cool, remind me at five",
    # continuations — leading positive + new information
    "okay, so the revenue is up",
    "great, the meeting went well",
    "perfect, that number matches the report from last quarter",
    # look-alike: "ill" (sick) is NOT "i'll" (self-commit), so the command stands
    "ill send it later",
    # bare positive buried in a longer sentence isn't an ending
    "great job on that whole project",
]


@pytest.mark.parametrize("text", KEEP_REPLYING)
def test_non_signoffs_keep_replying(text):
    result = evaluate(text, is_first_turn=False)
    assert result.should_end is False, f"expected REPLY for {text!r} ({result.reason})"


# --- Structural guarantees -------------------------------------------------------

def test_first_turn_is_never_a_signoff():
    # Even a bare "thanks" as the very first thing said must not be swallowed.
    assert is_signoff("thanks", is_first_turn=True) is False
    assert is_signoff("bye", is_first_turn=True) is False


def test_question_mark_always_keeps_replying():
    assert is_signoff("thanks?", is_first_turn=False) is False


def test_empty_transcript_keeps_replying():
    assert is_signoff("", is_first_turn=False) is False
    assert is_signoff("   ", is_first_turn=False) is False


def test_apostrophe_lookalikes_flip_the_decision():
    # The only difference is the apostrophe; the outcome must differ accordingly.
    assert is_signoff("i'll send it later", is_first_turn=False) is True   # self-commit
    assert is_signoff("ill send it later", is_first_turn=False) is False   # command


def test_reason_is_populated_for_tuning():
    assert evaluate("okay, thanks").reason
    assert evaluate("great, send that email").reason
