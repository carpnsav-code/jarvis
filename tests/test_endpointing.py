"""Tests for Tier 2 layered end-of-turn detection, driven by a fake clock."""

from jarvis.turn.endpointing import EndOfTurnDetector


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def advance_ms(self, ms: float) -> None:
        self.t += ms / 1000.0


def _detector(clock, fast=250, ceiling=1500):
    return EndOfTurnDetector(fast_confirm_ms=fast, silence_ceiling_ms=ceiling, clock=clock)


def test_no_speech_never_takes_turn():
    clock = FakeClock()
    d = _detector(clock)
    assert d.should_take_turn() is False
    clock.advance_ms(5000)
    assert d.should_take_turn() is False


def test_fast_path_waits_only_the_confirm_window():
    clock = FakeClock()
    d = _detector(clock, fast=250, ceiling=1500)
    d.on_final("hello there", speech_final=True)
    assert d.should_take_turn() is False        # confirm window not elapsed
    clock.advance_ms(200)
    assert d.should_take_turn() is False
    clock.advance_ms(60)                          # now 260ms >= 250ms
    assert d.should_take_turn() is True
    assert d.take_transcript() == "hello there"


def test_slow_path_uses_utterance_end_signal():
    clock = FakeClock()
    d = _detector(clock, fast=250, ceiling=1500)
    d.on_final("um well", speech_final=False)     # no endpoint flag
    clock.advance_ms(400)
    assert d.should_take_turn() is False          # not yet at ceiling, no signal
    d.on_utterance_end()
    assert d.should_take_turn() is True


def test_ceiling_guarantees_we_never_wait_too_long():
    clock = FakeClock()
    d = _detector(clock, fast=250, ceiling=1500)
    d.on_final("trailing off", speech_final=False)
    clock.advance_ms(1000)
    assert d.should_take_turn() is False
    clock.advance_ms(600)                          # 1600ms >= 1500ms ceiling
    assert d.should_take_turn() is True


def test_new_speech_cancels_a_pending_fast_confirm():
    clock = FakeClock()
    d = _detector(clock, fast=250, ceiling=1500)
    d.on_final("first part", speech_final=True)
    clock.advance_ms(100)
    d.on_interim("first part and more")            # person resumed talking
    clock.advance_ms(500)
    assert d.should_take_turn() is False           # must not fire mid-speech
    d.on_final("first part and more done", speech_final=True)
    clock.advance_ms(300)
    assert d.should_take_turn() is True


def test_transcript_accumulates_across_finals():
    clock = FakeClock()
    d = _detector(clock)
    d.on_final("hello", speech_final=False)
    d.on_final("world", speech_final=True)
    clock.advance_ms(300)
    assert d.should_take_turn() is True
    assert d.take_transcript() == "hello world"


def test_take_transcript_resets_state():
    clock = FakeClock()
    d = _detector(clock)
    d.on_final("done", speech_final=True)
    clock.advance_ms(300)
    d.take_transcript()
    assert d.has_speech is False
    assert d.should_take_turn() is False
