"""Tests for Tier 3/4 sentence chunking and the hold-one-ahead behavior."""

from jarvis.turn.sentence_chunker import SentenceChunker


def _run(chunks):
    """Feed a list of token strings, return the list of emitted Sentences."""
    chunker = SentenceChunker()
    out = []
    for c in chunks:
        out.extend(chunker.push(c))
    out.extend(chunker.flush())
    return out


def test_splits_into_sentences_in_order():
    out = _run(["Hello there. How are you? I'm fine."])
    assert [s.text for s in out] == ["Hello there.", "How are you?", "I'm fine."]


def test_exactly_one_sentence_is_marked_final():
    out = _run(["One. Two. Three."])
    finals = [s for s in out if s.is_final]
    assert len(finals) == 1
    assert finals[0].text == "Three."


def test_hold_one_ahead_delays_emission_by_one():
    # Pushing two complete sentences should emit only the first during push;
    # the second is held until flush.
    chunker = SentenceChunker()
    emitted = list(chunker.push("One. Two. "))
    assert [s.text for s in emitted] == ["One."]  # "Two." is held back
    tail = list(chunker.flush())
    assert [s.text for s in tail] == ["Two."]
    assert tail[0].is_final is True


def test_does_not_split_on_abbreviations():
    out = _run(["Dr. Smith is here. Bye."])
    assert [s.text for s in out] == ["Dr. Smith is here.", "Bye."]


def test_does_not_split_on_decimals():
    out = _run(["Pi is about 3.14 today. Done."])
    assert [s.text for s in out] == ["Pi is about 3.14 today.", "Done."]


def test_streams_across_many_tokens():
    # Simulate token-by-token arrival from an LLM stream.
    tokens = ["Hel", "lo. ", "How ", "are ", "you?", " Fine."]
    out = _run(tokens)
    assert [s.text for s in out] == ["Hello.", "How are you?", "Fine."]


def test_flush_releases_trailing_partial_as_final():
    out = _run(["A complete sentence. And a trailing fragment with no period"])
    assert out[-1].text == "And a trailing fragment with no period"
    assert out[-1].is_final is True


def test_tiny_trailing_fragment_is_glued_not_dropped():
    chunker = SentenceChunker()
    list(chunker.push("Hello there. "))  # held: "Hello there."
    list(chunker.push("x"))               # too short to be its own sentence
    out = list(chunker.flush())
    assert out == out  # sanity
    assert "x" in out[-1].text
    assert out[-1].is_final is True
