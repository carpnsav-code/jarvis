'use strict';

/**
 * Renderer: owns the YouTube iframe and relays player commands to it.
 *
 * The player isn't ready to accept postMessage commands the instant the iframe
 * fires `load` — it needs a beat to boot the JS API. So on every new load we
 * mark the player not-ready, and 700ms AFTER the iframe's onload we mark it
 * ready and flush anything that queued in the meantime. Commands that arrive
 * before then wait rather than being dropped on the floor.
 */

// Must match the embed host exactly — postMessage requires the target origin.
const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
const COMMAND_DELAY_MS = 700;

const iframe = document.getElementById('player');
const out = document.getElementById('out');
const input = document.getElementById('utterance');

let ready = false;
const pending = [];

function postToPlayer(message) {
  if (!iframe.contentWindow) return;
  iframe.contentWindow.postMessage(JSON.stringify(message), EMBED_ORIGIN);
}

function flush() {
  while (pending.length) postToPlayer(pending.shift());
}

function sendOrQueue(message) {
  if (ready) postToPlayer(message);
  else pending.push(message); // will be flushed once the player is ready
}

// Main hands us an embed URL to load. Loading a new video resets readiness.
window.jarvis.onPlayerLoad((url) => {
  ready = false;
  iframe.src = url;
});

// 700ms setTimeout after the iframe's onLoad before any postMessage is sent.
iframe.addEventListener('load', () => {
  if (!iframe.src) return; // ignore the initial blank load
  setTimeout(() => {
    ready = true;
    flush();
  }, COMMAND_DELAY_MS);
});

// Main hands us a postMessage payload (pauseVideo / playVideo / setVolume).
window.jarvis.onPlayerCommand((message) => sendOrQueue(message));

// --- Spotify now-playing (pushed by main after any state change) --------------
const nowPlaying = document.getElementById('nowplaying');
function renderNowPlaying(state) {
  if (!state || !state.track) {
    nowPlaying.hidden = true;
    return;
  }
  const artists = (state.artists || []).join(', ');
  const icon = state.playing ? '▶' : '⏸';
  nowPlaying.hidden = false;
  nowPlaying.textContent = `${icon} ${state.track}${artists ? ' — ' + artists : ''}` +
    (state.volume != null ? `  ·  vol ${state.volume}%` : '');
}
window.jarvis.onSpotifyState(renderNowPlaying);

document.getElementById('spotify-auth').addEventListener('click', async () => {
  out.textContent = 'Opening Spotify authorization…';
  const res = await window.jarvis.spotifyAuthorize();
  out.textContent = JSON.stringify(res, null, 2);
  if (res.ok) renderNowPlaying(await window.jarvis.spotifyState());
});

// --- Manual harness: type an utterance to exercise the same voice routing -----
async function run() {
  const text = input.value.trim();
  if (!text) return;
  const result = await window.jarvis.sendVoice(text);
  out.textContent = JSON.stringify(result, null, 2);
}
document.getElementById('go').addEventListener('click', run);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') run();
});
