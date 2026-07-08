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

let apps = [];
let appsPath = '';
let win = null;
let serverInfo = null;

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

/**
 * Route a raw voice utterance: video commands first, then fall back to
 * launching an app / opening a website. Always resolves to a structured result.
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
  // Not a video command — treat the utterance as an app/website request.
  return handleCommand({ action: text, target: text }, { apps });
}

app.whenReady().then(async () => {
  serverInfo = await startServer({ dir: __dirname });

  appsPath = path.join(app.getPath('userData'), 'apps.json');
  try {
    apps = loadApps(appsPath);
  } catch (err) {
    console.error(`Failed to load ${appsPath}: ${err.message}`);
    apps = [];
  }

  ipcMain.handle('assistant:command', (_event, command) =>
    handleCommand(command, { apps }),
  );
  ipcMain.handle('assistant:voice', (_event, text) => routeVoice(text));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverInfo) serverInfo.close();
  // Apps launched via computer control were spawned detached + unref()'d, so
  // they keep running even though the assistant quits here.
  if (process.platform !== 'darwin') app.quit();
});
