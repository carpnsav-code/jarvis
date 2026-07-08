# Jarvis — a voice assistant that feels human

Low latency, streamed end to end, and — the part most voice agents miss — it
knows when *not* to speak. Jarvis is a local mic/speaker voice loop built so that
listening, thinking, and speaking **overlap** instead of queuing up, and so a
clear goodbye ends the conversation instead of earning one more reply.

- **Ears:** [Deepgram](https://deepgram.com) streaming STT (real endpointing)
- **Brain:** [Claude](https://www.anthropic.com) (streaming + prompt caching)
- **Mouth:** [Cartesia](https://cartesia.ai) Sonic streaming TTS
- **Transport:** your machine's microphone and speaker

The design follows the "Make Your Voice AI Feel Human" tiers — each is a real,
named improvement, and each is wired in from the start rather than bolted on.

---

## Quick start

```bash
# 1. Install (a virtualenv is recommended)
pip install -e ".[dev]"

# 2. The provider-independent logic runs with NO API keys — start here:
pytest                       # sign-off, chunking, endpointing, metrics

# 3. For the live loop, add your keys and run:
cp .env.example .env         # then fill in the three keys
python -m jarvis.main
```

Speak naturally. Say "okay, thanks" or "bye" to see it wind down in silence.

On start it also serves the **holographic HUD dashboard** and opens it in your
browser (http://127.0.0.1:8765) — see below.

---

## The live HUD dashboard

Running the app launches a sci-fi HUD that shows the *real* assistant in real
time: a central reactor ring that changes color with state
(idle / listening / thinking / speaking), your transcript and Jarvis's streaming
reply, an audio spectrum driven by your actual mic and Jarvis's voice, and the
Tier-1 latency breakdown filling in after every turn.

- The Python engine pushes state to the page over a local WebSocket
  (`jarvis/dashboard/bridge.py`); the page routes events to one small UI API
  (`jarvis/dashboard/index.html`). The same page, opened on its own, plays a
  scripted demo — so it always shows *something*.
- Turn it off (pure CLI) with `JARVIS_DASHBOARD=false`; stop it auto-opening with
  `JARVIS_DASHBOARD_OPEN=false`; change the port with `JARVIS_DASHBOARD_PORT`.
- A dashboard problem never stops the voice loop — the assistant runs regardless.

---

## The tier map — where each idea lives

| Tier | Idea | Where |
|---|---|---|
| **1 — Measure first** | Five-number latency breakdown per turn (stop → transcript → first token → first byte → first sound); names the dominant cost. | `jarvis/metrics.py` |
| **2 — Start faster** | Layered end-of-turn: fast path on the recognizer's endpoint signal, slow path on `UtteranceEnd` + a silence ceiling. Check-and-go, never a blind sleep. | `jarvis/turn/endpointing.py` |
| **3 — Stream the thinking** | Claude streamed token by token; stable system prompt **cached**, the only dynamic value (time) sits after the cache breakpoint so long chats stay fast. | `jarvis/llm/claude_llm.py`, `jarvis/llm/prompt.py` |
| **4 — Stream the voice** | Reply chunked into sentences ("hold one ahead") and synthesized/played sentence by sentence; raw PCM at the playback rate — no conversion. | `jarvis/turn/sentence_chunker.py`, `jarvis/tts/cartesia_tts.py` |
| **5 — Know when to stop** | Deterministic, pre-LLM sign-off check. A goodbye costs zero tokens. Conservative by design — biased toward replying. | `jarvis/turn/signoff.py` |
| **6 — Polish** | Barge-in: speech during playback stops the audio and listens. Behavior locked in with tests. | `jarvis/audio/output.py`, `jarvis/conversation.py`, `tests/` |

The loop that ties them together is `jarvis/conversation.py`.

---

## Tuning (it's meant to be one-line)

Everything that shapes latency or behavior is an env var in `.env` (see
`.env.example` for the full list):

- **Snappier / more patient turn-taking:** `JARVIS_FAST_CONFIRM_MS`,
  `JARVIS_SILENCE_CEILING_MS`, `DEEPGRAM_ENDPOINTING_MS`,
  `DEEPGRAM_UTTERANCE_END_MS`. Test with slow talkers and mid-sentence pauses,
  not just clean one-liners.
- **Model quality vs. latency:** `JARVIS_MODEL` — `claude-haiku-4-5` (default,
  fastest) → `claude-sonnet-5` → `claude-opus-4-8`. Higher tiers give better
  answers at higher time-to-first-token.
- **Sign-off behavior:** the word lists live at the top of
  `jarvis/turn/signoff.py`. When a real goodbye slips through (or it goes quiet
  when it shouldn't have), move a phrase to the right bucket and **add the exact
  phrase to `tests/test_signoff.py`** so the behavior stays documented and can't
  silently regress. Disable entirely with `JARVIS_SIGNOFF_ENABLED=false`.

---

## Why the sign-off detector is conservative

The failure modes are not symmetric. Going silent when the person wanted a reply
reads as *broken*; replying to a borderline goodbye is just the mild old
behavior. So every layer biases toward replying: a sign-off phrase must actually
be present, and questions, requests, commands, continuations ("great, so the
revenue is up"), and look-alikes ("well" ≠ "we'll") all veto it. The very first
thing you say is never treated as a goodbye. See `tests/test_signoff.py` for the
exact cases the behavior is pinned to.

---

## See my screen

Say **"look at my screen"**, **"what do you see"**, or **"analyze my screen"** and
Jarvis captures the screen (all monitors), sends it to **Claude's native vision**,
and describes it in its own voice — not a robotic list. Add a question and it
answers directly instead of narrating: **"look at my screen and tell me what the
error says"** skips the description and just tells you.

- Detection is deterministic and runs **before** any model call
  (`jarvis/turn/screen_intent.py`), the same place sign-off does — every phrasing
  variant maps to one action so a command is never silently dropped.
- Capture uses `mss`, which grabs the real display regardless of window state, so
  it **works with the assistant minimized** — the reply comes back by voice only.
- Screenshots are downscaled (`JARVIS_VISION_MAX_EDGE`, default 1280px long edge)
  before encoding to keep vision tokens and latency down.
- No extra provider or key — Claude is already the brain and takes images
  directly. Disable with `JARVIS_VISION_ENABLED=false`.

If capture ever fails, Jarvis says so out loud and the conversation keeps going —
it never crashes the loop.

## Swapping a provider

The STT, LLM, and TTS each sit behind a small interface (`*/base.py`). Changing a
provider is an explicit new adapter plus a config change — never a silent
substitution, because that trade (cost, latency, quality, language) is yours to
make.

---

## Verifying the smoothness claims

1. **Latency:** every reply prints the Tier-1 breakdown. Watch the dominant cost
   shrink as you tune the tier that owns it.
2. **Caching stays warm:** from the second turn on, the report shows
   `prompt cache: N tokens read (hit)`. If it's ever zero, a changing value has
   crept into the cached prefix.
3. **Endings:** a clear sign-off prints `(sign-off: … — staying silent)` and
   produces no audio; questions and commands still get a normal reply.
4. **Barge-in:** start talking mid-reply — playback stops and it listens.
