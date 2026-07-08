"""Claude streaming LLM adapter (Tier 3 — the brain).

Streams the reply token by token via the Anthropic SDK's streaming helper, keeps
the conversation history, and uses prompt caching (the stable system prefix in
`prompt.py`) so a long conversation stays as fast at turn 15 as at turn 2.

After each turn it stashes `last_usage`, which the app prints so you can *verify*
caching is actually working: `cache_read_input_tokens` should be > 0 from the
second turn on. If it's zero, a silent invalidator has crept into the prefix.
"""

from __future__ import annotations

from datetime import datetime
from typing import AsyncIterator, Optional

from anthropic import AsyncAnthropic

from .base import LanguageModel
from .prompt import system_blocks


class ClaudeLLM(LanguageModel):
    def __init__(self, api_key: str, *, model: str, max_tokens: int) -> None:
        self._client = AsyncAnthropic(api_key=api_key)
        self._model = model
        self._max_tokens = max_tokens
        self._history: list[dict] = []
        self.last_usage: Optional[object] = None

    async def stream_reply(self, user_text: str) -> AsyncIterator[str]:
        self._history.append({"role": "user", "content": user_text})
        now_str = datetime.now().strftime("%A %B %d, %Y at %I:%M %p")

        parts: list[str] = []
        async with self._client.messages.stream(
            model=self._model,
            max_tokens=self._max_tokens,
            system=system_blocks(now_str),
            messages=self._history,
        ) as stream:
            async for text in stream.text_stream:
                parts.append(text)
                yield text
            final = await stream.get_final_message()

        reply = "".join(parts)
        self._history.append({"role": "assistant", "content": reply})
        self.last_usage = final.usage

    def cache_read_tokens(self) -> int:
        """Cache-read tokens from the most recent turn (0 if none / unknown)."""
        return int(getattr(self.last_usage, "cache_read_input_tokens", 0) or 0)

    def reset(self) -> None:
        self._history.clear()
        self.last_usage = None
