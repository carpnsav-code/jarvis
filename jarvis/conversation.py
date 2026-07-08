"""The conversation loop — where listen, think, and speak bleed into each other.

This is the orchestrator that wires every tier together:

  * Tier 1  — a `TurnTimer` per turn stamps the five latency milestones.
  * Tier 2  — STT events feed the layered `EndOfTurnDetector`; a check-and-go
              poll takes the turn the instant it's confident.
  * Tier 5  — before any model call, the sign-off detector can end the turn in
              silence (a goodbye costs nothing).
  * Tier 3  — the LLM reply streams token by token...
  * Tier 4  — ...through the SentenceChunker into streaming TTS, so the first
              sentence is spoken while the model writes the next.
  * Tier 6  — speech during playback triggers barge-in: we stop and listen.

The three concurrent jobs — pumping mic->STT, consuming STT events, and driving
turns — run as asyncio tasks on one loop.
"""

from __future__ import annotations

import asyncio
import time

from .audio.input import MicrophoneInput
from .audio.output import SpeakerOutput
from .config import Config
from .llm.base import LanguageModel
from .metrics import TurnTimer
from .stt.base import SpeechToText
from .tts.base import TextToSpeech
from .turn import signoff
from .turn.endpointing import EndOfTurnDetector
from .turn.sentence_chunker import SentenceChunker


class Conversation:
    def __init__(
        self,
        config: Config,
        mic: MicrophoneInput,
        speaker: SpeakerOutput,
        stt: SpeechToText,
        llm: LanguageModel,
        tts: TextToSpeech,
    ) -> None:
        self._config = config
        self._mic = mic
        self._speaker = speaker
        self._stt = stt
        self._llm = llm
        self._tts = tts
        self._endpointer = EndOfTurnDetector(
            fast_confirm_ms=config.fast_confirm_ms,
            silence_ceiling_ms=config.silence_ceiling_ms,
        )
        self._running = False
        self._responding = False
        self._response_task: asyncio.Task | None = None
        self._turn_index = 0
        self._last_final_time: float | None = None

    async def run(self) -> None:
        self._running = True
        await self._stt.connect()
        self._mic.start()
        self._speaker.start()
        print("Jarvis is listening. Speak naturally — say 'thanks' or 'bye' to wrap up.\n")
        try:
            await asyncio.gather(
                self._audio_pump(),
                self._stt_pump(),
                self._turn_loop(),
            )
        finally:
            await self._shutdown()

    # --- pumping mic audio into the recognizer --------------------------------

    async def _audio_pump(self) -> None:
        async for chunk in self._mic.chunks():
            if not self._running:
                return
            await self._stt.send(chunk)

    # --- consuming recognizer events ------------------------------------------

    async def _stt_pump(self) -> None:
        async for ev in self._stt.events():
            if not self._running:
                return
            if ev.kind == "interim":
                if ev.text:
                    self._on_user_speaking()
                self._endpointer.on_interim(ev.text)
            elif ev.kind == "final":
                if ev.text:
                    self._on_user_speaking()
                self._last_final_time = time.monotonic()
                self._endpointer.on_final(ev.text, speech_final=ev.speech_final)
            elif ev.kind == "utterance_end":
                self._endpointer.on_utterance_end()

    def _on_user_speaking(self) -> None:
        """Any voiced content while we're talking = barge-in: stop and listen."""
        if self._responding:
            self._interrupt_response()

    def _interrupt_response(self) -> None:
        self._speaker.interrupt()
        if self._response_task is not None and not self._response_task.done():
            self._response_task.cancel()
        self._responding = False
        print("  (barge-in — stopped to listen)")

    # --- driving turns (check-and-go, never a blind sleep) --------------------

    async def _turn_loop(self) -> None:
        while self._running:
            await asyncio.sleep(0.03)
            if self._responding:
                continue
            if self._endpointer.should_take_turn():
                transcript = self._endpointer.take_transcript()
                stopped_at = self._last_final_time or time.monotonic()
                await self._handle_turn(transcript, stopped_at)

    async def _handle_turn(self, transcript: str, stopped_at: float) -> None:
        self._turn_index += 1
        print(f"you: {transcript}")

        # Tier 5 — decide *before* any model call whether to stay silent.
        if self._config.signoff_enabled:
            verdict = signoff.evaluate(
                transcript, is_first_turn=(self._turn_index == 1)
            )
            if verdict.should_end:
                print(f"  (sign-off: {verdict.reason} — staying silent)\n")
                return

        timer = TurnTimer()
        timer.stamp("stopped_speaking_at", stopped_at)
        timer.mark_transcript_final()
        self._responding = True
        self._speaker.arm_first_sound(timer.mark_first_sound)
        self._response_task = asyncio.create_task(
            self._stream_response(transcript, timer)
        )

    # --- streaming think -> speak (Tiers 3 & 4) -------------------------------

    async def _stream_response(self, transcript: str, timer: TurnTimer) -> None:
        chunker = SentenceChunker()
        printed_prefix = False
        try:
            async for token in self._llm.stream_reply(transcript):
                timer.mark_first_llm_token()
                if not printed_prefix:
                    print("jarvis: ", end="", flush=True)
                    printed_prefix = True
                print(token, end="", flush=True)
                for sentence in chunker.push(token):
                    await self._speak(sentence, timer)
            for sentence in chunker.flush():
                await self._speak(sentence, timer)
            print()
            self._report(timer)
        except asyncio.CancelledError:
            print()  # response was barged-in; leave the loop in a clean state
            raise
        finally:
            self._responding = False

    async def _speak(self, sentence, timer: TurnTimer) -> None:
        async for pcm in self._tts.synthesize(sentence.text, is_final=sentence.is_final):
            timer.mark_first_tts_byte()
            self._speaker.enqueue(pcm)

    # --- reporting -------------------------------------------------------------

    def _report(self, timer: TurnTimer) -> None:
        print(timer.render())
        cache_reads = getattr(self._llm, "cache_read_tokens", lambda: 0)()
        if cache_reads:
            print(f"    prompt cache: {cache_reads} tokens read (hit)")
        print()

    # --- teardown --------------------------------------------------------------

    async def _shutdown(self) -> None:
        self._running = False
        if self._response_task is not None and not self._response_task.done():
            self._response_task.cancel()
        self._speaker.interrupt()
        self._mic.stop()
        self._speaker.stop()
        await self._stt.close()
        await self._tts.close()
