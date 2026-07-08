"""Tests for screen-look intent detection.

Pins the spec's two modes: bare "look at my screen" style phrases DESCRIBE;
"...and tell me X" style phrases ANSWER X directly.
"""

import pytest

from jarvis.turn.screen_intent import evaluate


# --- DESCRIBE mode: request, no specific question --------------------------------

DESCRIBE = [
    "look at my screen",
    "analyze my screen",
    "what do you see",
    "what's on my screen",
    "what am i looking at",
    "hey jarvis, take a look at this",
    "can you look at my screen",
]


@pytest.mark.parametrize("text", DESCRIBE)
def test_describe_mode(text):
    r = evaluate(text)
    assert r.is_request is True, f"{text!r} should be a screen request ({r.reason})"
    assert r.question is None, f"{text!r} should be DESCRIBE, got question={r.question!r}"


# --- ANSWER mode: request with a specific question -------------------------------

ANSWER = [
    "look at my screen and tell me what the error says",
    "look at my screen and tell me how many tabs are open",
    "analyze my screen and summarize the document",
    "check my screen and read me the phone number",
    "what do you see in the top right corner",
    "what's on my screen, are there any errors",
]


@pytest.mark.parametrize("text", ANSWER)
def test_answer_mode_sets_a_question(text):
    r = evaluate(text)
    assert r.is_request is True, f"{text!r} should be a screen request ({r.reason})"
    assert r.question, f"{text!r} should be ANSWER mode with a question ({r.reason})"


def test_answer_question_is_extracted_cleanly():
    r = evaluate("look at my screen and tell me what the error says")
    assert r.question == "what the error says"


def test_question_trigger_uses_full_utterance():
    r = evaluate("what do you see in the terminal")
    assert r.question == "what do you see in the terminal"


# --- Not a screen request --------------------------------------------------------

NOT_SCREEN = [
    "what's the weather today",
    "add a meeting for friday",
    "play some music",
    "thanks, that's all",
    "",
    "   ",
]


@pytest.mark.parametrize("text", NOT_SCREEN)
def test_non_screen_requests(text):
    r = evaluate(text)
    assert r.is_request is False, f"{text!r} is not a screen request ({r.reason})"
    assert r.question is None


def test_reason_is_populated():
    assert evaluate("look at my screen").reason
    assert evaluate("what's the weather").reason
