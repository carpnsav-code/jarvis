"""System prompt construction with cache-safety baked in (Tier 3).

The big win for keeping a long conversation fast is prompt caching, and the
classic bug is a small *changing* value (a timestamp) wedged early in the prompt
that silently invalidates the cache for everything after it, so responses creep
slower the deeper you go.

We avoid that structurally:
  * The large, **stable** instruction block carries the `cache_control`
    breakpoint and is byte-identical every turn -> it is read from cache.
  * The only per-turn dynamic value (the current time) goes in a separate block
    placed **after** that breakpoint, so it can never break the cached prefix.

The instructions themselves also serve smoothness: lead with the answer, keep it
short, offer detail only if asked — long replies are the enemy of conversation.
"""

from __future__ import annotations

# Stable prefix — must stay byte-identical turn to turn for the cache to hit.
STABLE_SYSTEM = """You are Jarvis, a voice assistant. The user is *speaking* to \
you and *hearing* your replies, so write for the ear, not the page.

How to sound human:
- Lead with the answer. Say the useful thing first; add detail only if asked.
- Be brief. One or two sentences is usually right. Long answers are the enemy \
of conversation.
- Use plain, spoken language. No bullet points, no markdown, no headings, no \
emoji, no code blocks — those don't exist out loud.
- Spell things out the way you'd say them (say "twenty percent", not "20%").
- If a request is ambiguous, ask one short clarifying question rather than \
guessing at length.
- It's fine to let a conversation end. Don't manufacture a reason to keep \
talking or grab the last word."""


def system_blocks(now_str: str) -> list[dict]:
    """Return the Anthropic `system` blocks: cached stable prefix + dynamic tail.

    `now_str` is the only thing that changes between turns and it sits *after*
    the cache breakpoint, so the cached prefix is never disturbed.
    """
    return [
        {
            "type": "text",
            "text": STABLE_SYSTEM,
            "cache_control": {"type": "ephemeral"},
        },
        {
            # Dynamic — intentionally after the breakpoint above.
            "type": "text",
            "text": f"The current time is {now_str}.",
        },
    ]
