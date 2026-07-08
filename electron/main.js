'use strict';

/**
 * Electron main-process entry.
 *
 * This is the thin wiring layer. All the computer-control logic lives in
 * computerControl.js (and is unit-tested there without Electron); here we just:
 *
 *   1. figure out where the user's apps.json lives (Electron's userData dir),
 *   2. load/seed it once at startup,
 *   3. expose a single IPC channel the renderer/assistant calls to run a
 *      command, returning a structured result it can speak.
 *
 * The renderer never touches child_process — only the main process spawns, so
 * the privileged surface stays here and stays small.
 */

const path = require('path');
const { app, ipcMain, BrowserWindow } = require('electron');
const { loadApps, handleCommand } = require('./computerControl');

// Populated at startup from apps.json (seeded with defaults on first run).
let apps = [];
let appsPath = '';

function createWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 640,
    webPreferences: {
      // Keep Node out of the renderer; commands cross the IPC boundary instead.
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  return win;
}

app.whenReady().then(() => {
  appsPath = path.join(app.getPath('userData'), 'apps.json');
  try {
    apps = loadApps(appsPath);
  } catch (err) {
    // A corrupt apps.json shouldn't take the app down; run with an empty
    // catalogue and let each command report "no app catalogue".
    console.error(`Failed to load ${appsPath}: ${err.message}`);
    apps = [];
  }

  // The one channel the assistant calls: give it { action, target }, get back
  // the structured launch result. Always resolves — never throws across IPC.
  ipcMain.handle('assistant:command', (_event, command) =>
    handleCommand(command, { apps }),
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Launched apps were spawned detached + unref()'d, so they keep running even
  // as the assistant itself quits here.
  if (process.platform !== 'darwin') app.quit();
});
