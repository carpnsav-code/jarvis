"""Entrypoint: build the components from config and run the conversation loop.

    python -m jarvis.main      (or the `jarvis` console script)

Requires the three API keys in `.env` (copy from `.env.example`). The
provider-independent logic (sign-off detection, chunking, endpointing, metrics)
is exercised by `pytest` without any keys — this module is only the live loop.
"""

from __future__ import annotations

import asyncio

from .config import Config
from .conversation import Conversation


async def _main() -> None:
    config = Config.from_env()
    config.require_keys()

    # Imported here (not at module top) so `pytest` and the pure-logic modules
    # never need the provider SDKs or audio devices installed.
    from .audio.input import MicrophoneInput
    from .audio.output import SpeakerOutput
    from .llm.claude_llm import ClaudeLLM
    from .stt.deepgram_stt import DeepgramSTT
    from .tts.cartesia_tts import CartesiaTTS

    loop = asyncio.get_running_loop()

    mic = MicrophoneInput(config.sample_rate, loop)
    speaker = SpeakerOutput(config.sample_rate)
    stt = DeepgramSTT(
        config.deepgram_api_key,
        model=config.deepgram_model,
        sample_rate=config.sample_rate,
        endpointing_ms=config.deepgram_endpointing_ms,
        utterance_end_ms=config.deepgram_utterance_end_ms,
    )
    llm = ClaudeLLM(
        config.anthropic_api_key,
        model=config.model,
        max_tokens=config.max_tokens,
    )
    tts = CartesiaTTS(
        config.cartesia_api_key,
        model=config.cartesia_model,
        sample_rate=config.sample_rate,
        voice_id=config.cartesia_voice_id,
    )

    print(f"model: {config.model}  |  sample rate: {config.sample_rate} Hz")
    conversation = Conversation(config, mic, speaker, stt, llm, tts)
    await conversation.run()


def run() -> None:
    """Console-script / CLI entrypoint."""
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        print("\nGoodbye.")


if __name__ == "__main__":
    run()
