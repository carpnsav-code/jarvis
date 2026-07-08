'use strict';

/**
 * Preload bridge. The renderer gets no direct access to Node, child_process, or
 * the filesystem — only this small, explicit surface:
 *
 *   runCommand(command) → invoke a structured { action, target } launch.
 *   sendVoice(text)     → route a raw utterance (video player, else launch).
 *   onPlayerLoad(cb)    → main asks the renderer to load an embed URL.
 *   onPlayerCommand(cb) → main asks the renderer to postMessage the player.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  runCommand: (command) => ipcRenderer.invoke('assistant:command', command),
  sendVoice: (text) => ipcRenderer.invoke('assistant:voice', text),
  onPlayerLoad: (cb) => ipcRenderer.on('player:load', (_event, url) => cb(url)),
  onPlayerCommand: (cb) =>
    ipcRenderer.on('player:command', (_event, message) => cb(message)),
  // Spotify
  spotifyAuthorize: () => ipcRenderer.invoke('spotify:authorize'),
  spotifyState: () => ipcRenderer.invoke('spotify:getState'),
  onSpotifyState: (cb) => ipcRenderer.on('spotify:state', (_event, state) => cb(state)),
  // Voice output + greeting
  tts: (text) => ipcRenderer.invoke('tts:speak', text),
  greeting: () => ipcRenderer.invoke('assistant:greeting'),
});
