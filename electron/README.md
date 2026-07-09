# Jarvis desktop assistant (Electron)

A standalone, always-listening desktop voice assistant. It hears you (Web Speech
API), routes what you said to a device command *or* the brain (Groq), and talks
back (ElevenLabs, or the Web Speech voice keyless). On top of the brain sit the
"pro" capabilities: launching apps, a YouTube player, web search, persistent
memory, and Spotify control.

This is the guide's Electron/Groq/Web-Speech stack. (The repo also contains a
separate Python voice loop under `jarvis/` — Deepgram/Claude/Cartesia — which is
an alternative brain/voice stack, not wired to this app.)

## The voice loop

```
🎤 Web Speech recognition (always on)
   → main process routeVoice(text)
        video command?  → control the player,  speak a confirmation
        music command?  → control Spotify,     speak a confirmation
        launch command? → spawn the app,       speak a confirmation
        otherwise       → web search (gated) → brain (Groq) → speak the answer
   → 🔊 ElevenLabs audio (or Web Speech voice), text revealed as audio starts
```

Device commands are deterministic and skip the LLM (instant, zero tokens);
anything else goes to the brain, with live search data and remembered facts
injected as context. Mic and speaker each have a mute toggle; the input bar
pulses while listening; a greeting is spoken on boot.

## Computer control

Lets Jarvis act on the machine: **launch apps and open websites from natural
commands**. The assistant decides *what* the user wants; this module decides
*how* to do it and actually spawns the program.

It mirrors Jarvis's design elsewhere — deterministic, defensive, and pinned by
tests — so a command is understood or reported, never silently dropped, and a
bad path is spoken back, never a crash.

## Layout

| File | Job |
|---|---|
| `computerControl.js` | App launching: catalogue load/seed, intent normalisation, app matching, detached spawn. Electron-free and unit-tested. |
| `defaultApps.js` | The default app/website catalogue, per platform, seeded on first run. |
| `youtube.js` | Embed-URL builder, search-URL builder, results-page scrape for the first video id. |
| `videoControl.js` | Voice → player intents (search / pause / resume / volume) and the raw postMessage payloads. |
| `webSearch.js` | Layered web search (DuckDuckGo → Brave → TechCrunch) + weather / market / Instagram sources. |
| `searchGate.js` | Groq YES/NO check on whether a message needs live data (skipped for greetings). |
| `fileCreation.js` / `documentBuilder.js` | Generate a PDF/document from a request and save it to the Desktop (dependency-free PDF writer). |
| `productivity.js` | Keyless Gmail-compose / Google-Calendar deep links from voice. |
| `groqBrain.js` | The brain: Groq chat replies with multi-key failover + a personality prompt. |
| `elevenlabs.js` | Optional ElevenLabs voice output (keyless fallback is the Web Speech voice). |
| `outcome.js` | Turns command/search results into a spoken line or brain context. |
| `spotify.js` | Spotify Web API: OAuth flow, silent token refresh, track scoring, device pick, playback. |
| `memoryStore.js` | Persistent history + facts, atomic writes with a backup, under a fixed path. |
| `memoryExtractor.js` | Fire-and-forget Groq call that extracts durable facts after each turn. |
| `missionLog.js` | The mission log — console + `~/.jarvis/mission.log`; where background failures surface. |
| `paths.js` | The fixed `~/.jarvis` storage location (deliberately not %APPDATA%). |
| `server.js` | Loopback HTTP server that hosts the renderer (see "Why an HTTP server"). |
| `main.js` | Electron entry: starts the server, loads the catalogue, exposes the IPC channels, drives the player. |
| `preload.js` | Bridges a small surface to the renderer — no raw Node in the UI. |
| `renderer.js` / `index.html` | The interface: the YouTube iframe + a manual harness for the same routing. |
| `test/` | `node --test` behavior tests — the record of what the routers are pinned to. |

## How a command flows

```
{ action: "open app", target: "browse the web" }
        │
        ▼  canonIntent(action)      → collapse every launch-like verb to "launch"
        ▼  matchApp(apps, target)   → find the app by id / name / intent phrase
        ▼  resolveLaunch(app)       → { path, args }  (a website = browser + URL arg)
        ▼  launchApp({ path, args }) → existsSync guard, then spawn detached + unref
        ▼
{ ok: true, app: "web_search", pid: 1234, ... }
```

### The four guarantees

- **One internal action.** `canonIntent()` maps `open app`, `launch
  application`, `run program`, … — and any unrecognised verb — to a single
  `launch` action, so the router never fails to recognise a phrasing and go
  quiet. Only explicitly non-launch verbs (`close`, `mute`, `screenshot`, …)
  are handed off instead.
- **Websites are browser arguments.** Opening a page spawns the browser
  executable with the URL as a command-line argument. We never automate clicks
  inside a browser window.
- **No spawn without existsSync.** Every launch checks the executable exists
  first and returns a readable `"I couldn't find X"` result if not.
- **Launched apps outlive the assistant.** Every spawn is `detached: true` +
  `child.unref()`, so quitting Jarvis leaves your apps running.

## App definitions (`userData/apps.json`)

Seeded with platform defaults on first run; your edits are never clobbered.

```jsonc
// a plain app
{ "id": "calculator", "name": "Calculator", "type": "app",
  "path": "/usr/bin/gnome-calculator", "args": [],
  "intent": ["calculator", "do some math"] }

// a website (opened via the browser)
{ "id": "youtube", "name": "YouTube", "type": "website",
  "url": "https://www.youtube.com", "browser": "browser",
  "intent": ["youtube", "watch videos"] }
```

Add a new phrase for an app by dropping it into that app's `intent` array — no
code change. Add a new app or deep link by adding an entry.

### Deep links

Some website entries jump straight to an action instead of a home page — e.g.
"new Google Doc" → `https://docs.google.com/document/create`, plus new
Sheets/Slides, compose-email, and Instagram. The Instagram URL ships with a
placeholder handle (`your_handle` in `defaultApps.js`) — set it to your real
handle there or in `apps.json`.

## YouTube video player

The interface embeds a YouTube player as a plain iframe (no YouTube SDK) using
the privacy host `youtube-nocookie.com`. Playback is driven by voice through the
`assistant:voice` channel:

| Say | Effect |
|---|---|
| "play a video about **X**" | scrape YouTube results for **X**, load the first hit |
| "pause the video" | postMessage `pauseVideo` |
| "resume the video" | postMessage `playVideo` |
| "set volume to **N**" | postMessage `setVolume` with **N** (0–100) |

### Why an HTTP server (not file://)

The YouTube embed's JS API checks the `origin` param against the parent frame's
origin. A `file://` page has a *null* origin, which the embed rejects with
**Error 153**. So `server.js` serves the renderer from `http://127.0.0.1` on an
OS-assigned free port, and that address becomes `location.origin` in the embed
URL. Nothing is exposed off loopback.

### The 700ms delay

The player can't accept postMessage commands the instant the iframe fires
`load` — the JS API needs a beat to boot. So after every load the renderer waits
**700ms (a setTimeout on the iframe's onload)** before it will post commands;
anything that arrives earlier is queued and flushed once ready, never dropped.

Search runs in the main process (`youtube.js`): it scrapes
`youtube.com/results?…&sp=EgIQAQ%3D%3D` (the video-only filter) with a desktop
User-Agent and pulls the first `"videoId"` out of the embedded JSON.

## The brain (Groq)

Anything that isn't a device command is answered by Groq (`groqBrain.js`,
default model `llama3-70b-8192`). Add **up to four keys** (`GROQ_API_KEY`,
`GROQ_API_KEY_2..4`) and it fails over automatically — a 429/401/5xx on one key
rotates to the next, so a rate limit never stops the conversation. A
**personality** system prompt (`GROQ_PERSONALITY`) runs every turn, and
remembered facts + any live search data are injected as context so the brain
uses what the assistant knows. Without a key, device commands still work and the
brain politely says it needs one.

## Voice (Web Speech + ElevenLabs)

- **Input**: always-on `SpeechRecognition` in the renderer; final transcripts go
  through the same router. Mic mute button; the bar pulses while listening.
- **Output**: ElevenLabs audio when `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`
  are set (fetched in the main process, so the key never reaches the renderer);
  otherwise the Web Speech voice (deep male, rate 0.82, pitch 0.6, 250ms between
  sentences). The reply text is revealed only as audio starts, so they sync.
- **Greeting**: `JARVIS_GREETING` is spoken once on boot.

## Web search

`assistant:search` (and any information-seeking utterance through
`assistant:voice`) runs a layered chain — **no keys required for the baseline**.
Every request sends the exact desktop User-Agent Chrome string; without it
DuckDuckGo serves a bot page and Instagram returns 401.

**General query**
1. **DuckDuckGo** HTML scrape (`html.duckduckgo.com`, `Cache-Control: no-cache`),
   parsing the `result__a` / `result__snippet` classes. We never use the Instant
   Answer API — it's empty for real queries.
2. **Brave Search API** — only if `BRAVE_API_KEY` is set, only when DDG is empty.
3. **TechCrunch AI feed** — last resort, only for AI-news queries.

**Specialised sources** (matched first, by query shape)

| Query | Source |
|---|---|
| weather | `wttr.in/{loc}?format=j1` (structured JSON) |
| BTC / ETH / S&P 500 price | Yahoo Finance chart API |
| Instagram followers | `i.instagram.com` web profile API (needs the app-id header) |

### The search gate

Before a search, `searchGate.js` runs a fast Groq YES/NO on whether the message
actually needs live data — so "tell me a joke" doesn't fetch anything. Trivial
messages ("hey", "ok", "thanks") **skip the gate entirely** (no Groq call at
all). With no `GROQ_API_KEY`, the gate fails open and search still runs.

## File creation

Say "create a PDF about the solar system", "make a document about my trip", or
"write a note to buy milk". The brain writes the content, and a dependency-free
PDF writer (`documentBuilder.js`) or a text file is saved straight to your
**Desktop** with a tidy timestamped name. Notes stay as your literal words; PDFs
and documents get brain-generated bodies.

## GoHighLevel (live CRM control)

With `GHL_API_TOKEN` + `GHL_LOCATION_ID` set, Jarvis actually *operates* your
GoHighLevel account by voice — "what are my open deals", "how many contacts do
I have", "text Sam saying I'm running late". `ghlClient.js` is a live API client
(same base URL / version / auth as the GHL repo); `ghlAgent.js` runs a Groq
tool-calling loop that lets the model pick and call the CRM tools, execute them
for real, and speak the result. Multi-step requests work (find a contact, then
message them). Without the token it politely says it's not connected. Verified
live: it read back a real pipeline and open-deal count.

## App integrations (keyless)

Rather than a full OAuth flow per service, these open the service's own compose
page with details pre-filled:

- "email sam@example.com about lunch" → Gmail compose, already addressed.
- "add a calendar event dentist on Friday 3pm" → Google Calendar event template.

## Persistent memory

The assistant remembers across sessions. Two things are stored in a single JSON
file under a **fixed path** (`~/.jarvis/memory.json`):

- **Conversation history** — every turn.
- **Durable facts** — a separate list (preferences, personal details, ongoing
  projects) extracted from conversations.

Why a fixed path and not `%APPDATA%`/`userData`? That path shifts with how the
app is launched (installed vs portable vs dev), which would split memory across
files. `~/.jarvis` is stable.

**Durability.** Writes are atomic (write `…json.tmp`, then rename over the real
file) so a crash mid-save can't corrupt it, and the last good file is copied to
`memory.backup.json` before every write, so load can fall back to it. On close
the app forces an immediate synchronous `flush()` — it does not trust the
debounce timer to fire during teardown.

**Fact extraction.** After each turn (`assistant:remember`), a background Groq
call extracts memorable facts and adds them to the list. It's strictly
fire-and-forget, so it never delays the response, and any failure is logged to
the **mission log** (`~/.jarvis/mission.log`) rather than vanishing.

**Using what it remembers.** `assistant:context` returns the stored facts
formatted as a prompt block to inject into the next AI call, and known facts are
fed back into the extractor so it doesn't re-suggest them.

**Single instance.** A single-instance lock means launching a second copy just
focuses the existing window — two processes never race on the save file.

## Spotify

Voice control of Spotify playback (requires Spotify Premium). Set up a free app
at developer.spotify.com, then click **Connect Spotify** in the window (or call
`spotify:authorize`).

**Auth.** Authorization Code flow: a temporary server on `127.0.0.1:8888` catches
the OAuth redirect, the code is exchanged for tokens, and the server closes. Only
the **refresh token** is persisted (`~/.jarvis/spotify.json`); access tokens stay
in memory and are refreshed silently before each call with a 30-second buffer.
The Client ID/Secret live in the main process only (`SPOTIFY_CLIENT_ID` /
`SPOTIFY_CLIENT_SECRET`) — never in the renderer, where devtools could read them.

**Search.** Fetches 10 candidates (`limit=10` — Spotify 400s above that with
field filters) and scores them to prefer exact artist + title, pushing covers,
remixes, and live versions down unless you ask for them ("play X live by Y").

**Devices.** Uses the active device, else the first available; if none exist it
returns a clear "open Spotify on any device first".

**Commands.** `play [song] by [artist]`, `pause`/`resume` the music, `next`,
`previous`, `volume up`, `volume down`. After any change the new playback state
is pushed to the UI (`spotify:state`) so the now-playing display updates live.

> Routing note: bare "pause"/"resume" go to the *video* player; music pause/resume
> is "pause the music". `next`/`previous`/`volume up`/`down` and "play X by Y" are
> unambiguous and always route to Spotify.

## Run

```bash
cd electron
npm install       # pulls Electron
npm start         # starts the loopback server + launches the window
npm test          # node --test, no Electron needed
```
