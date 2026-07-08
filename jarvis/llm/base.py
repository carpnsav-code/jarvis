"""Language-model interface (the brain).

Abstract so the loop never hard-depends on Anthropic. The one method that
matters for smoothness is `stream_reply`: it must yield text **as it is
generated**, token by token, so the first sentence can head to the voice while
the model is still writing the second (Tier 3).
"""

from __future__ import annotations

import abc
from typing import AsyncIterator


class LanguageModel(abc.ABC):
    @abc.abstractmethod
    def stream_reply(self, user_text: str) -> AsyncIterator[str]:
        """Yield the reply as a stream of text chunks. Also responsible for
        maintaining conversation history across turns."""

    def reset(self) -> None:  # pragma: no cover - optional hook
        """Clear conversation history (start a fresh conversation)."""
