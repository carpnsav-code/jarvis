'use strict';

/**
 * Voice → video-player commands.
 *
 * Turns a spoken utterance into one of four player intents and, for the
 * side-effecting ones, into the raw postMessage payload the YouTube iframe
 * understands (no YouTube SDK involved).
 *
 *   "play a video about jazz"  → { kind: 'search', query: 'jazz' }
 *   "pause the video"          → { kind: 'pause' }
 *   "resume the video"         → { kind: 'resume' }
 *   "set volume to 40"         → { kind: 'volume', value: 40 }
 *
 * parseVideoCommand() is pure and returns null for anything that isn't a video
 * command, so the caller can fall through to other routing (e.g. launching an
 * app) without a video command ever being silently swallowed.
 */

const { buildEmbedUrl } = require('./youtube');

// kind → the YouTube iframe API function name sent over postMessage.
const PLAYER_FUNCS = Object.freeze({
  pause: 'pauseVideo',
  resume: 'playVideo',
  volume: 'setVolume',
});

function normalise(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampVolume(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Parse an utterance into a player intent, or null if it isn't one.
 *
 * Order matters: volume and pause/resume are checked before search so that
 * "play the video" (resume) is never mistaken for "play a video about …"
 * (search).
 *
 * @param {string} text
 * @returns {{kind:'search',query:string}|{kind:'pause'}|{kind:'resume'}|{kind:'volume',value:number}|null}
 */
function parseVideoCommand(text) {
  const t = normalise(text);
  if (!t) return null;

  // Volume: "set volume to 40", "volume 40", "set the volume at 40".
  const vol = t.match(/\bvolume\b(?:\s+(?:to|at|of|level))?\s+(\d{1,3})/);
  if (vol) return { kind: 'volume', value: clampVolume(Number(vol[1])) };

  // Pause.
  if (/\bpause\b/.test(t)) return { kind: 'pause' };

  // Resume: explicit resume words, or "play the/this/that/it video", or a bare
  // "play"/"resume"/"continue". Checked before search so it wins the ambiguity.
  if (
    /\b(resume|unpause|continue)\b/.test(t) ||
    /\bplay (?:the|this|that|it) video\b/.test(t) ||
    /^play(?: it| again)?$/.test(t)
  ) {
    return { kind: 'resume' };
  }

  // Search: "play a video about X", "find a video of X", "search youtube for X",
  // "put on a video about X", "watch a video on X".
  const search = t.match(
    /\b(?:play|find|search|watch|put on|pull up|show me)\b.*?\bvideo[s]?\b\s*(?:about|of|on|for|by|with|called|titled)?\s*(.+)/,
  );
  if (search && search[1].trim()) {
    return { kind: 'search', query: search[1].trim() };
  }

  // "search youtube for X" / "youtube X" without the literal word "video".
  const yt = t.match(/\b(?:search youtube for|play on youtube|youtube)\b\s+(.+)/);
  if (yt && yt[1].trim()) return { kind: 'search', query: yt[1].trim() };

  return null;
}

/**
 * Build the postMessage payload for a control intent. The YouTube iframe API
 * listens for `{ event: 'command', func, args }` when the embed has
 * enablejsapi=1.
 *
 * @param {'pause'|'resume'|'volume'} kind
 * @param {number} [value]  required for volume (0–100)
 * @returns {{event:'command', func:string, args:Array}}
 */
function buildPlayerMessage(kind, value) {
  const func = PLAYER_FUNCS[kind];
  if (!func) throw new Error(`No player function for "${kind}".`);
  const args = kind === 'volume' ? [clampVolume(Number(value))] : [];
  return { event: 'command', func, args };
}

/**
 * Execute a parsed video command. Search hits the network (injected) and tells
 * the renderer which URL to load; control commands go straight to the renderer
 * as postMessage payloads. Purely orchestration — the deps are injected so this
 * is testable without Electron or the network.
 *
 * @param {object} parsed  from parseVideoCommand
 * @param {object} deps
 * @param {(query:string)=>Promise<string>} deps.searchImpl  query → videoId
 * @param {(url:string)=>void} deps.sendLoad     tell renderer to load a URL
 * @param {(msg:object)=>void} deps.sendCommand  tell renderer to postMessage
 * @param {string} deps.origin  the page origin for the embed URL
 * @returns {Promise<object>} structured result the assistant can speak
 */
async function runVideoCommand(parsed, { searchImpl, sendLoad, sendCommand, origin }) {
  if (parsed.kind === 'search') {
    const videoId = await searchImpl(parsed.query);
    const url = buildEmbedUrl(videoId, origin);
    sendLoad(url);
    return { ok: true, kind: 'search', query: parsed.query, videoId, url };
  }

  const message = buildPlayerMessage(parsed.kind, parsed.value);
  sendCommand(message);
  return { ok: true, kind: parsed.kind, message };
}

module.exports = {
  PLAYER_FUNCS,
  parseVideoCommand,
  buildPlayerMessage,
  runVideoCommand,
};
