'use strict';

/**
 * Browser bridge for the web-server mode (no Electron).
 *
 * Provides the same `window.jarvis` surface the renderer expects, but backed by
 * fetch() calls to the local Node server instead of Electron IPC. The player /
 * Spotify "push" callbacks are fired from each /api/voice response, so the
 * existing renderer.js works unchanged.
 */

(function () {
  const cbs = {};

  async function postJson(url, data) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {}),
    });
    return res.json();
  }

  window.jarvis = {
    greeting: async () => (await fetch('/api/greeting')).text(),

    sendVoice: async (text) => {
      const d = await postJson('/api/voice', { text });
      if (d.playerUrl && cbs.playerLoad) cbs.playerLoad(d.playerUrl);
      if (d.playerCommand && cbs.playerCommand) cbs.playerCommand(d.playerCommand);
      if (d.spotifyState && cbs.spotifyState) cbs.spotifyState(d.spotifyState);
      return { speech: d.speech };
    },

    runCommand: (command) => postJson('/api/voice', { text: (command && command.target) || '' }),
    tts: (text) => postJson('/api/tts', { text }),

    spotifyAuthorize: () => postJson('/api/spotify/authorize', {}),
    spotifyState: async () => (await fetch('/api/spotify/state')).json(),

    onPlayerLoad: (cb) => {
      cbs.playerLoad = cb;
    },
    onPlayerCommand: (cb) => {
      cbs.playerCommand = cb;
    },
    onSpotifyState: (cb) => {
      cbs.spotifyState = cb;
    },
  };
})();
