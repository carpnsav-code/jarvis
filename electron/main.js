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
const { app, ipcMain, BrowserWindow } = require('electron');
const { loadApps, handleCommand } = require('./computerControl');
const { startServer } = require('./server');
const { searchYouTube } = require('./youtube');
const { parseVideoCommand, runVideoCommand } = require('./videoControl');
const { search } = require('./webSearch');
const { searchGate } = require('./searchGate');
const { MemoryStore } = require('./memoryStore');
const { extractInBackground } = require('./memoryExtractor');
const missionLog = require('./missionLog');

let apps = [];
let appsPath = '';
let win = null;
let serverInfo = null;
let memory = null;

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

/**
 * Route a raw voice utterance. Order: video commands → information questions
 * (web search, gated) → launching an app / opening a website. If a launch
 * finds no match, we fall through to search as a last resort. Always resolves
 * to a structured result.
 */
async function routeVoice(text) {
  const parsed = parseVideoCommand(text);
  if (parsed) {
    try {
      return await runVideoCommand(parsed, {
        searchImpl: (q) => searchYouTube(q),
        sendLoad: (url) => win && win.webContents.send('player:load', url),
        sendCommand: (msg) => win && win.webContents.send('player:command', msg),
        origin: serverInfo.url,
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  const t = String(text || '').trim().toLowerCase();
  if (QUESTION_LIKE.test(t)) {
    return runSearch(text);
  }

  // Try to launch an app / open a website; if nothing matches, search instead.
  const launched = handleCommand({ action: text, target: text }, { apps });
  if (launched.ok) return launched;
  return runSearch(text);
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
    ipcMain.handle('assistant:voice', (_event, text) => routeVoice(text));
    ipcMain.handle('assistant:search', (_event, text) => runSearch(text));
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
