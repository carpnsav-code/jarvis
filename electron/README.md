# Computer control (Electron main process)

Lets Jarvis act on the machine: **launch apps and open websites from natural
commands**. The assistant decides *what* the user wants; this module decides
*how* to do it and actually spawns the program.

It mirrors Jarvis's design elsewhere — deterministic, defensive, and pinned by
tests — so a command is understood or reported, never silently dropped, and a
bad path is spoken back, never a crash.

## Layout

| File | Job |
|---|---|
| `computerControl.js` | All the logic: catalogue load/seed, intent normalisation, app matching, detached spawn. Electron-free and unit-tested. |
| `defaultApps.js` | The default app/website catalogue, per platform, seeded on first run. |
| `main.js` | Electron entry: loads the catalogue, exposes the `assistant:command` IPC channel. |
| `preload.js` | Bridges one `runCommand()` function to the renderer — no raw Node in the UI. |
| `index.html` | A tiny manual harness for the same channel. |
| `test/` | `node --test` behavior tests — the record of what the router is pinned to. |

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

## Run

```bash
cd electron
npm install       # pulls Electron
npm start         # launches the manual harness window
npm test          # node --test, no Electron needed
```
