'use strict';

/**
 * Electron main-process entry.
 *
 * Thin wiring over the logic modules. At startup it:
 *   1. starts a loopback HTTP server and points the window at it (NOT file://,
 *      which YouTube's embed rejects with Error 153),
 *   2. loads/seeds the app catalogue (userData/apps.json),
 *   3. exposes two IPC channels:
 *        assistant:command  { action, target }  → launch an app / open a website
 *        assistant:voice    "raw utterance"      → video player, else app launch
 *
 * Video playback is driven the other way (main → renderer) via webContents.send:
 * 'player:load' hands the renderer an embed URL; 'player:command' hands it a
 * postMessage payload. Only the main process spawns or scrapes; the renderer
 * just owns the iframe.
 */

const path = require('path');
// Load .env (repo-root and electron/) before anything reads process.env.
require('./envLoader').loadEnv();
const { app, ipcMain, BrowserWindow, shell } = require('electron');
const { loadApps, handleCommand } = require('./computerControl');
const { startServer } = require('./server');
const { searchYouTube } = require('./youtube');
const { parseVideoCommand, runVideoCommand } = require('./videoControl');
const { search } = require('./webSearch');
const { searchGate } = require('./searchGate');
const { MemoryStore } = require('./memoryStore');
const { extractInBackground } = require('./memoryExtractor');
const missionLog = require('./missionLog');
const { GroqBrain, loadGroqKeys } = require('./groqBrain');
const elevenlabs = require('./elevenlabs');
const outcome = require('./outcome');
const { parseCreateCommand, createFile } = require('./fileCreation');
const { parseProductivityCommand, resolveProductivity } = require('./productivity');
const {
  parseSpotifyCommand,
  runSpotifyCommand,
  authorize: spotifyAuthorize,
  loadRefreshToken,
  saveRefreshToken,
  SpotifyClient,
} = require('./spotify');

let apps = [];
let appsPath = '';
let win = null;
let serverInfo = null;
let memory = null;
let spotify = null;
let brain = null;

const GREETING = process.env.JARVIS_GREETING || 'Jarvis online. How can I help?';

function createWindow() {
  win = new BrowserWindow({
    width: 960,
    height: 720,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      // Let the embedded player autoplay without a click, since the "command"
      // to play came by voice.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  // Served over http on loopback — this is location.origin for the embed.
  win.loadURL(serverInfo.url);
  return win;
}

// Utterances that are asking for information rather than an action. When one of
// these leads, we route to web search (behind the gate) instead of trying to
// launch an app.
const QUESTION_LIKE =
  /^(who|what|whats|when|where|why|how|which|is|are|do|does|did|can|could|should|will)\b|\b(search|look up|lookup|google|find out|weather|forecast|price|news|followers)\b/;

/** Run the search gate, then search if live data is actually wanted. */
async function runSearch(text) {
  const gate = await searchGate(text);
  if (!gate.live) {
    return { ok: true, action: 'answer', search: false, gate };
  }
  try {
    const result = await search(text);
    return { ok: true, action: 'search', gate, ...result };
  } catch (err) {
    return { ok: false, action: 'search', gate, error: err.message };
  }
}

/** Ask the brain for a reply, degrading gracefully without a Groq key. */
async function brainReply(text, context) {
  if (brain && brain.isConfigured()) {
    try {
      return await brain.reply(text, { context });
    } catch (err) {
      missionLog.error(`brain: reply failed — ${err.message}`);
      return context || "I'm having trouble reaching my brain right now.";
    }
  }
  // No brain: speak fetched data directly, or say we can't answer.
  if (context) return context;
  return "I can't answer that yet — add a Groq API key to give me a brain.";
}

/** Create a file from a parsed command: the brain writes the body, we save it. */
async function runCreateFile(create) {
  const topic = create.topic || 'Untitled';
  const title = topic.replace(/^\w/, (c) => c.toUpperCase());
  let body = topic;
  if (create.kind !== 'note' && brain && brain.isConfigured()) {
    try {
      body = await brain.reply(
        `Write the full text content for a ${create.kind} about: ${topic}. ` +
          'Return only the document body — no preamble, no markdown fences.',
        {},
      );
    } catch (err) {
      missionLog.error(`file: content generation failed — ${err.message}`);
    }
  }
  try {
    const r = createFile({ kind: create.kind, title, body });
    const noun = create.kind === 'pdf' ? 'PDF' : create.kind === 'note' ? 'note' : 'document';
    return { speech: `Saved your ${noun} to the Desktop.`, handled: true, detail: r };
  } catch (err) {
    missionLog.error(`file: save failed — ${err.message}`);
    return { speech: "I couldn't save that file.", handled: true, detail: { error: err.message } };
  }
}

/**
 * Route a raw voice utterance to a spoken reply. Order: deterministic device
 * commands first (video → music → launch), which return a short confirmation
 * and skip the LLM entirely; otherwise the brain answers, with live search data
 * injected as context when the question needs it. Always resolves to
 * `{ speech, handled, detail }`.
 */
async function routeVoice(text) {
  // 1. Video player commands.
  const video = parseVideoCommand(text);
  if (video) {
    try {
      const r = await runVideoCommand(video, {
        searchImpl: (q) => searchYouTube(q),
        sendLoad: (url) => win && win.webContents.send('player:load', url),
        sendCommand: (msg) => win && win.webContents.send('player:command', msg),
        origin: serverInfo.url,
      });
      return { speech: outcome.videoSpeech(r), handled: true, detail: r };
    } catch (err) {
      return { speech: "I couldn't play that video.", handled: true, detail: { error: err.message } };
    }
  }

  // 2. Music (Spotify) commands.
  const music = parseSpotifyCommand(text);
  if (music) {
    const r = await runSpotifyCommand(spotify, music);
    return { speech: outcome.spotifySpeech(r), handled: true, detail: r };
  }

  // 3. File creation: "create a pdf about …", "write a note …".
  const create = parseCreateCommand(text);
  if (create) {
    return runCreateFile(create);
  }

  // 4. Productivity deep links: draft an email / add a calendar event.
  const productivity = parseProductivityCommand(text);
  if (productivity) {
    const { url, speech } = resolveProductivity(productivity);
    shell.openExternal(url);
    return { speech, handled: true, detail: productivity };
  }

  // 5. Question → search (gated); or app launch; else brain, with any fetched
  //    data injected as context.
  const t = String(text || '').trim().toLowerCase();
  let context = '';
  if (QUESTION_LIKE.test(t)) {
    const s = await runSearch(text);
    if (s.action === 'search') context = outcome.searchToContext(s);
  } else {
    const launched = handleCommand({ action: text, target: text }, { apps });
    if (launched.ok) return { speech: outcome.launchSpeech(launched), handled: true, detail: launched };
    const s = await runSearch(text);
    if (s.action === 'search') context = outcome.searchToContext(s);
  }

  const reply = await brainReply(text, context);
  return { speech: reply, handled: false, detail: { context: Boolean(context) } };
}

/**
 * Record a completed exchange and kick off background fact extraction. Returns
 * immediately — extraction is fire-and-forget so it never delays the response.
 */
function rememberTurn(userText, assistantText) {
  if (!memory) return { ok: false, error: 'memory not ready' };
  memory.addTurn('user', userText);
  memory.addTurn('assistant', assistantText);
  extractInBackground(memory, userText, assistantText); // not awaited
  return { ok: true };
}

// Single-instance lock: if another copy is already running, hand off to it
// (focus its window) and quit, rather than starting a second process that would
// race on the memory save file and corrupt it.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    serverInfo = await startServer({ dir: __dirname });
    memory = new MemoryStore();
    missionLog.info(`memory: loaded ${memory.getFacts().length} fact(s), ${memory.getHistory().length} history entr(ies)`);

    // Spotify client. Client ID/Secret stay in the main process (env), never
    // the renderer. Only the refresh token is persisted.
    spotify = new SpotifyClient({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      refreshToken: loadRefreshToken(),
      onState: (state) => win && win.webContents.send('spotify:state', state),
    });
    if (spotify.isConnected()) missionLog.info('spotify: connected (refresh token loaded)');

    // The brain (Groq, multi-key failover). Facts from memory are injected into
    // every reply's system prompt.
    brain = new GroqBrain({
      keys: loadGroqKeys(),
      model: process.env.GROQ_MODEL,
      personality: process.env.GROQ_PERSONALITY,
      knowledge: require('./knowledge').loadKnowledge(),
      factsProvider: () => (memory ? memory.factsContext() : ''),
    });
    missionLog.info(
      brain.isConfigured()
        ? `brain: ready with ${brain.keys.length} Groq key(s)`
        : 'brain: no Groq key — chat replies disabled until one is set',
    );

    appsPath = path.join(app.getPath('userData'), 'apps.json');
    try {
      apps = loadApps(appsPath);
    } catch (err) {
      missionLog.error(`Failed to load ${appsPath}: ${err.message}`);
      apps = [];
    }

    ipcMain.handle('assistant:command', (_event, command) =>
      handleCommand(command, { apps }),
    );
    ipcMain.handle('assistant:voice', async (_event, text) => {
      const result = await routeVoice(text);
      rememberTurn(text, result.speech); // record + background fact extraction
      return result;
    });
    ipcMain.handle('assistant:search', (_event, text) => runSearch(text));
    // Voice output: ElevenLabs audio when configured, else null (renderer uses
    // the Web Speech API voice).
    ipcMain.handle('tts:speak', async (_event, text) => {
      try {
        return { audio: await elevenlabs.synthesize(text) };
      } catch (err) {
        missionLog.error(`tts: ElevenLabs failed — ${err.message}`);
        return { audio: null };
      }
    });
    ipcMain.handle('assistant:greeting', () => GREETING);
    // Memory channels.
    ipcMain.handle('assistant:remember', (_event, turn) =>
      rememberTurn((turn && turn.user) || '', (turn && turn.assistant) || ''),
    );
    ipcMain.handle('assistant:memory', () => ({
      facts: memory.getFacts(),
      history: memory.getHistory(),
    }));
    // The facts formatted for injection into the next AI call's context.
    ipcMain.handle('assistant:context', () => memory.factsContext());

    // Spotify: interactive authorize (opens the browser, catches the redirect).
    ipcMain.handle('spotify:authorize', async () => {
      if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
        return { ok: false, error: 'Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET first.' };
      }
      try {
        const refreshToken = await spotifyAuthorize({
          clientId: process.env.SPOTIFY_CLIENT_ID,
          clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
          openUrl: (url) => shell.openExternal(url),
        });
        saveRefreshToken(refreshToken);
        spotify.refreshToken = refreshToken;
        missionLog.info('spotify: authorized and refresh token saved');
        return { ok: true };
      } catch (err) {
        missionLog.error(`spotify: authorization failed — ${err.message}`);
        return { ok: false, error: err.message };
      }
    });
    ipcMain.handle('spotify:getState', () => spotify.getPlaybackState());

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// Force an immediate, synchronous save on the way out — don't trust the
// debounce timer to fire during teardown.
app.on('before-quit', () => {
  if (!memory) return;
  try {
    memory.flush();
  } catch (err) {
    missionLog.error(`memory: final flush failed — ${err.message}`);
  }
});

app.on('window-all-closed', () => {
  if (serverInfo) serverInfo.close();
  // Apps launched via computer control were spawned detached + unref()'d, so
  // they keep running even though the assistant quits here.
  if (process.platform !== 'darwin') app.quit();
});
