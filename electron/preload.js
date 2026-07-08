'use strict';

/**
 * Preload bridge. Exposes exactly one function to the renderer — run a command —
 * over Electron's contextBridge. The renderer gets no direct access to Node,
 * child_process, or the filesystem; the only thing it can do is ask the main
 * process to handle an { action, target } command and await the result.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  /**
   * @param {{ action?: string, target?: string }} command
   * @returns {Promise<object>} the structured launch result
   */
  runCommand: (command) => ipcRenderer.invoke('assistant:command', command),
});
