"""Tests for the Tier 1 TurnTimer latency breakdown."""

from pytest import approx

from jarvis.metrics import TurnTimer


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def at_ms(self, ms: float) -> None:
        self.t = ms / 1000.0


def test_segments_and_total_are_computed():
    clock = FakeClock()
    timer = TurnTimer(clock=clock)
    clock.at_ms(0);    timer.mark_stopped_speaking()
    clock.at_ms(120);  timer.mark_transcript_final()
    clock.at_ms(400);  timer.mark_first_llm_token()
    clock.at_ms(520);  timer.mark_first_tts_byte()
    clock.at_ms(600);  timer.mark_first_sound()

    segs = timer.segments_ms()
    assert segs["stop -> transcript final"] == approx(120)
    assert segs["transcript -> first token"] == approx(280)
    assert segs["first token -> first audio byte"] == approx(120)
    assert segs["first byte -> first sound"] == approx(80)
    assert timer.total_ms() == approx(600)


def test_only_first_mark_counts():
    clock = FakeClock()
    timer = TurnTimer(clock=clock)
    clock.at_ms(100); timer.mark_first_llm_token()
    clock.at_ms(999); timer.mark_first_llm_token()  # should be ignored
    assert timer.first_llm_token_at == approx(0.1)


def test_render_names_the_dominant_cost():
    clock = FakeClock()
    timer = TurnTimer(clock=clock)
    clock.at_ms(0);   timer.mark_stopped_speaking()
    clock.at_ms(50);  timer.mark_transcript_final()
    clock.at_ms(900); timer.mark_first_llm_token()   # biggest gap
    clock.at_ms(950); timer.mark_first_tts_byte()
    clock.at_ms(1000); timer.mark_first_sound()
    text = timer.render()
    assert "dominant cost" in text
    assert "transcript -> first token" in text


def test_missing_marks_render_gracefully():
    timer = TurnTimer()
    # Nothing marked — should not raise, total is None.
    assert timer.total_ms() is None
    assert isinstance(timer.render(), str)
