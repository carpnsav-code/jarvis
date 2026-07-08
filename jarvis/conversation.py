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
from .audio.level import rms_level
from .audio.output import SpeakerOutput
from .config import Config
from .llm.base import LanguageModel
from .metrics import TurnTimer
from .stt.base import SpeechToText
from .tts.base import TextToSpeech
from .turn import screen_intent, signoff
from .turn.endpointing import EndOfTurnDetector
from .turn.sentence_chunker import SentenceChunker
from .vision import capture


class Conversation:
    def __init__(
        self,
        config: Config,
        mic: MicrophoneInput,
        speaker: SpeakerOutput,
        stt: SpeechToText,
        llm: LanguageModel,
        tts: TextToSpeech,
        bridge=None,
    ) -> None:
        self._config = config
        self._mic = mic
        self._speaker = speaker
        self._stt = stt
        self._llm = llm
        self._tts = tts
        self._bridge = bridge          # optional DashboardBridge (Phase 2)
        self._endpointer = EndOfTurnDetector(
            fast_confirm_ms=config.fast_confirm_ms,
            silence_ceiling_ms=config.silence_ceiling_ms,
        )
        self._running = False
        self._responding = False
        self._response_task: asyncio.Task | None = None
        self._turn_index = 0
        self._last_final_time: float | None = None
        self._ui_state = "idle"

    # --- dashboard event emission (no-op when no bridge) ----------------------

    def _emit(self, **event) -> None:
        if self._bridge is not None:
            self._bridge.emit(event)

    def _set_state(self, state: str) -> None:
        if state != self._ui_state:
            self._ui_state = state
            self._emit(type="state", value=state)

    async def run(self) -> None:
        self._running = True
        await self._stt.connect()
        self._mic.start()
        self._speaker.start()
        self._emit(type="config", model=self._config.model, sampleRate=self._config.sample_rate)
        self._emit(type="state", value="idle")
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
            # Feed the HUD spectrum from the live mic level while we're listening
            # (TTS output drives it while speaking — see _speak).
            if self._bridge is not None and not self._responding:
                self._emit(type="level", value=rms_level(chunk))

    # --- consuming recognizer events ------------------------------------------

    async def _stt_pump(self) -> None:
        async for ev in self._stt.events():
            if not self._running:
                return
            if ev.kind == "interim":
                if ev.text:
                    self._on_user_speaking()
                    if not self._responding:
                        self._set_state("listening")
                        self._emit(type="transcript", text=ev.text)
                self._endpointer.on_interim(ev.text)
            elif ev.kind == "final":
                if ev.text:
                    self._on_user_speaking()
                    if not self._responding:
                        self._emit(type="transcript", text=ev.text)
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
        self._set_state("listening")
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
        self._emit(type="transcript", text=transcript)
        self._emit(type="turn", role="you", text=transcript)

        # Tier 5 — decide *before* any model call whether to stay silent.
        if self._config.signoff_enabled:
            verdict = signoff.evaluate(
                transcript, is_first_turn=(self._turn_index == 1)
            )
            if verdict.should_end:
                print(f"  (sign-off: {verdict.reason} — staying silent)\n")
                self._emit(type="reply", text="(sign-off — staying silent)", streaming=False)
                self._emit(type="latency", ms=None)
                self._set_state("idle")
                return

        timer = TurnTimer()
        timer.stamp("stopped_speaking_at", stopped_at)
        timer.mark_transcript_final()
        self._responding = True
        self._set_state("thinking")
        self._emit(type="reply", text="", streaming=True)
        self._speaker.arm_first_sound(timer.mark_first_sound)
        self._response_task = asyncio.create_task(self._respond(transcript, timer))

    # --- choosing what to say (normal vs. look-at-my-screen) -------------------

    async def _respond(self, transcript: str, timer: TurnTimer) -> None:
        """Pick a token source for this turn, then drive it to the speaker."""
        tokens = None
        if self._config.vision_enabled:
            intent = screen_intent.evaluate(transcript)
            if intent.is_request:
                tokens = await self._vision_tokens(intent)
        if tokens is None:
            tokens = self._llm.stream_reply(transcript)
        await self._drive_response(tokens, timer)

    async def _vision_tokens(self, intent: screen_intent.ScreenIntent):
        """Capture the screen (in the background) and return a vision token stream.

        Capture runs in an executor so it never blocks the loop, and works even
        when our window is minimized. On failure we speak a readable line instead
        of crashing the conversation.
        """
        mode = "answering" if intent.question else "describing"
        print(f"  (capturing screen — {mode})")
        try:
            loop = asyncio.get_running_loop()
            images = await loop.run_in_executor(
                None, capture.capture_all_monitors_b64, self._config.vision_max_edge
            )
        except Exception as exc:  # capture is best-effort; never take down the loop
            print(f"  (screen capture failed: {exc})")
            return self._static_tokens("I couldn't capture the screen just now.")
        if not images:
            return self._static_tokens("I couldn't find a screen to look at.")
        return self._llm.stream_vision_reply(images, question=intent.question)

    @staticmethod
    async def _static_tokens(text: str):
        """A one-shot token stream so a fixed line flows through the normal
        chunker -> TTS path (used for readable capture errors)."""
        yield text

    # --- streaming think -> speak (Tiers 3 & 4) -------------------------------

    async def _drive_response(self, tokens, timer: TurnTimer) -> None:
        chunker = SentenceChunker()
        printed_prefix = False
        reply = ""
        try:
            async for token in tokens:
                timer.mark_first_llm_token()
                if not printed_prefix:
                    print("jarvis: ", end="", flush=True)
                    printed_prefix = True
                    self._set_state("speaking")
                print(token, end="", flush=True)
                reply += token
                self._emit(type="reply", text=reply, streaming=True)
                for sentence in chunker.push(token):
                    await self._speak(sentence, timer)
            for sentence in chunker.flush():
                await self._speak(sentence, timer)
            print()
            self._report(timer)
            self._emit(type="reply", text=reply, streaming=False)
            if reply.strip():
                self._emit(type="turn", role="jarvis", text=reply.strip())
            self._emit_metrics(timer)
            self._set_state("idle")
        except asyncio.CancelledError:
            print()  # response was barged-in; leave the loop in a clean state
            raise
        finally:
            self._responding = False

    async def _speak(self, sentence, timer: TurnTimer) -> None:
        async for pcm in self._tts.synthesize(sentence.text, is_final=sentence.is_final):
            timer.mark_first_tts_byte()
            self._speaker.enqueue(pcm)
            # Drive the HUD spectrum from the audio Jarvis is speaking.
            if self._bridge is not None:
                self._emit(type="level", value=rms_level(pcm))

    # --- reporting -------------------------------------------------------------

    def _report(self, timer: TurnTimer) -> None:
        print(timer.render())
        cache_reads = getattr(self._llm, "cache_read_tokens", lambda: 0)()
        if cache_reads:
            print(f"    prompt cache: {cache_reads} tokens read (hit)")
        print()

    def _emit_metrics(self, timer: TurnTimer) -> None:
        if self._bridge is None:
            return
        segs = timer.segments_ms()
        cache_reads = getattr(self._llm, "cache_read_tokens", lambda: 0)()
        self._emit(
            type="metrics",
            stopToFinal=segs["stop -> transcript final"],
            finalToToken=segs["transcript -> first token"],
            tokenToByte=segs["first token -> first audio byte"],
            byteToSound=segs["first byte -> first sound"],
            total=timer.total_ms(),
            cacheTokens=cache_reads,
            model=self._config.model,
            sampleRate=self._config.sample_rate,
        )

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
