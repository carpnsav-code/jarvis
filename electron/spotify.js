'use strict';

/**
 * Spotify integration via the Web API (OAuth Authorization Code flow).
 *
 * Security: the Client ID and Secret live only in the main process (passed into
 * SpotifyClient) — never in the renderer, where devtools could read them. Only
 * the **refresh token** is persisted (~/.jarvis/spotify.json); access tokens
 * expire in an hour and are kept in memory only, refreshed silently before each
 * call with a 30-second safety buffer.
 *
 * The pure bits — command parsing, track scoring, device pick, the authorize
 * URL — are exported and unit-tested. The networked SpotifyClient takes an
 * injectable fetch so it's testable without hitting Spotify.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SPOTIFY_TOKEN_FILE } = require('./paths');

const AUTH_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com';
const CALLBACK_PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const REFRESH_BUFFER_MS = 30_000; // refresh 30s before expiry
const VOLUME_STEP = 10;

// All three scopes are required; missing any one makes playback commands fail
// silently (per Spotify).
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
];

// Track-name markers we push down unless the user asked for them.
const VARIANT_WORDS = ['remix', 'cover', 'live', 'karaoke', 'instrumental', 'acoustic', 'sped up', 'slowed', 'reverb'];

// --- Pure: command parsing ------------------------------------------------------

function normalise(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Parse a music command, or null if it isn't one.
 *
 * Handles: "play X by Y", "play the song X", "play some music", next/previous,
 * volume up/down, and music-qualified pause/resume ("pause the music"). Bare
 * "pause"/"resume" are intentionally left to the video player.
 *
 * @param {string} text
 * @returns {object|null}
 */
function parseSpotifyCommand(text) {
  const t = normalise(text);
  if (!t) return null;

  if (/\bnext( song| track)?\b|\bskip( song| track)?\b/.test(t)) return { kind: 'next' };
  if (/\bprevious( song| track)?\b|\bgo back a (song|track)\b|\blast song\b/.test(t)) return { kind: 'previous' };
  if (/\b(volume up|turn (it|the volume) up|louder|crank it)\b/.test(t)) return { kind: 'volumeUp' };
  if (/\b(volume down|turn (it|the volume) down|quieter|softer|lower the volume)\b/.test(t)) return { kind: 'volumeDown' };

  if (/\b(pause|stop)\b.*\b(music|song|track|spotify)\b/.test(t)) return { kind: 'pause' };
  if (/\b(resume|unpause|continue)\b.*\b(music|song|track|spotify)\b/.test(t)) return { kind: 'resume' };

  // "play X by Y"
  const byMatch = t.match(/\bplay\s+(.+?)\s+by\s+(.+)$/);
  if (byMatch) {
    return { kind: 'play', song: byMatch[1].trim(), artist: byMatch[2].trim(), query: t };
  }
  // "play some music" / "play music" / "play spotify"
  if (/\bplay\s+(some\s+)?(music|spotify)\b/.test(t)) {
    return { kind: 'resume', query: t };
  }
  // "play the song X" / "play song X" / "play track X"
  const songMatch = t.match(/\bplay\s+(?:the\s+)?(?:song|track)\s+(.+)$/);
  if (songMatch) {
    return { kind: 'play', song: songMatch[1].trim(), query: t };
  }

  return null;
}

// --- Pure: track scoring --------------------------------------------------------

function requestedVariants(query) {
  const q = normalise(query);
  return VARIANT_WORDS.filter((w) => q.includes(w));
}

/**
 * Score a Spotify track against what was asked for. Higher is better.
 * Prioritises exact artist and song matches; pushes covers/remixes/live/etc.
 * down unless the query explicitly asked for that variant.
 *
 * @param {object} track  Spotify track object
 * @param {{song?:string, artist?:string, query?:string}} want
 * @returns {number}
 */
function scoreTrack(track, want = {}) {
  const name = normalise(track && track.name);
  const artists = ((track && track.artists) || []).map((a) => normalise(a.name));
  const song = normalise(want.song);
  const artist = normalise(want.artist);
  const wanted = requestedVariants(want.query || `${want.song || ''} ${want.artist || ''}`);

  let score = Number(track && track.popularity) || 0;

  if (artist) {
    if (artists.includes(artist)) score += 1000;
    else if (artists.some((a) => a.includes(artist) || artist.includes(a))) score += 200;
    else score -= 200; // wrong artist
  }

  if (song) {
    if (name === song) score += 300;
    else if (name.startsWith(song)) score += 150;
    else if (name.includes(song)) score += 80;
  }

  // Variant handling. An unrequested variant in the name is pushed down hard; a
  // variant the user explicitly asked for is rewarded.
  for (const v of VARIANT_WORDS) {
    if (!name.includes(v)) continue;
    if (wanted.includes(v)) score += 300;
    else score -= 800;
  }
  // If the user asked for a variant (e.g. "live"), a track lacking it loses out
  // to one that has it.
  for (const v of wanted) {
    if (!name.includes(v)) score -= 500;
  }

  return score;
}

/**
 * Pick the best track from candidates.
 * @param {object[]} tracks
 * @param {object} want
 * @returns {object|null}
 */
function pickBestTrack(tracks, want = {}) {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const track of tracks) {
    const s = scoreTrack(track, want);
    if (s > bestScore) {
      bestScore = s;
      best = track;
    }
  }
  return best;
}

// --- Pure: device selection -----------------------------------------------------

/**
 * Choose a device: the active one, else the first available.
 * @param {object[]} devices
 * @returns {object|null}
 */
function pickDevice(devices) {
  if (!Array.isArray(devices) || !devices.length) return null;
  return devices.find((d) => d.is_active) || devices[0];
}

// --- Pure: authorize URL --------------------------------------------------------

function buildAuthorizeUrl(clientId, redirectUri = REDIRECT_URI, scopes = SCOPES, state = '') {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: scopes.join(' '),
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTH_BASE}/authorize?${params.toString()}`;
}

// --- Token persistence (refresh token only) -------------------------------------

function loadRefreshToken(file = SPOTIFY_TOKEN_FILE) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).refreshToken || null;
  } catch {
    /* ignore — treat as not connected */
  }
  return null;
}

function saveRefreshToken(refreshToken, file = SPOTIFY_TOKEN_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ refreshToken }, null, 2), 'utf8');
}

// --- OAuth: interactive authorize -----------------------------------------------

function basicAuth(clientId, clientSecret) {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

/**
 * Run the Authorization Code flow: open a temp server on 8888, send the user to
 * Spotify, catch the redirect, exchange the code, and return ONLY the refresh
 * token. The server is closed as soon as the code arrives.
 *
 * @param {object} deps
 * @param {string} deps.clientId
 * @param {string} deps.clientSecret
 * @param {(url:string)=>void} deps.openUrl  opens the consent page in a browser
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {number} [deps.port]
 * @returns {Promise<string>} the refresh token
 */
function authorize({ clientId, clientSecret, openUrl, fetchImpl = fetch, port = CALLBACK_PORT }) {
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = crypto.randomBytes(8).toString('hex');

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url.startsWith('/callback')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const url = new URL(req.url, redirectUri);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font:16px system-ui;padding:2rem">Spotify connected. You can close this tab and return to Jarvis.</body></html>');
      server.close();

      if (error) return reject(new Error(`Spotify authorization denied: ${error}`));
      if (!code) return reject(new Error('Spotify authorization returned no code.'));

      try {
        const res2 = await fetchImpl(`${AUTH_BASE}/api/token`, {
          method: 'POST',
          headers: { Authorization: basicAuth(clientId, clientSecret), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
        });
        if (!res2.ok) throw new Error(`token exchange failed: HTTP ${res2.status}`);
        const tokens = await res2.json();
        if (!tokens.refresh_token) throw new Error('no refresh token in response');
        resolve(tokens.refresh_token); // persist ONLY this
      } catch (err) {
        reject(err);
      }
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      openUrl(buildAuthorizeUrl(clientId, redirectUri, SCOPES, state));
    });
  });
}

// --- The networked client -------------------------------------------------------

class SpotifyClient {
  constructor({ clientId, clientSecret, refreshToken, fetchImpl = fetch, onState } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken || null;
    this.fetchImpl = fetchImpl;
    this.onState = onState || null; // called with playback state after changes
    this.accessToken = null;
    this.expiresAt = 0; // epoch ms
  }

  isConnected() {
    return Boolean(this.clientId && this.clientSecret && this.refreshToken);
  }

  /** Silent refresh: only hits the network when the token is missing/near expiry. */
  async ensureAccessToken(now = Date.now()) {
    if (this.accessToken && now < this.expiresAt - REFRESH_BUFFER_MS) return this.accessToken;
    if (!this.refreshToken) throw new Error('Spotify is not connected. Authorize first.');

    const res = await this.fetchImpl(`${AUTH_BASE}/api/token`, {
      method: 'POST',
      headers: { Authorization: basicAuth(this.clientId, this.clientSecret), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken }).toString(),
    });
    if (!res.ok) throw new Error(`Spotify token refresh failed: HTTP ${res.status}`);
    const data = await res.json();
    this.accessToken = data.access_token; // in memory only — never persisted
    this.expiresAt = now + Number(data.expires_in || 3600) * 1000;
    // Spotify may rotate the refresh token.
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    return this.accessToken;
  }

  async api(pathname, { method = 'GET', query, body } = {}) {
    const token = await this.ensureAccessToken();
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    const res = await this.fetchImpl(`${API_BASE}${pathname}${qs}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null; // no content (common for playback ops)
    if (!res.ok) throw new Error(`Spotify API ${method} ${pathname} → HTTP ${res.status}`);
    // Some endpoints return empty bodies with 200.
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async getDevices() {
    const data = await this.api('/v1/me/player/devices');
    return (data && data.devices) || [];
  }

  /** Active device, or first available; throws a clear message when none exist. */
  async requireDevice() {
    const device = pickDevice(await this.getDevices());
    if (!device) throw new Error('No Spotify device found. Open Spotify on any device first.');
    return device;
  }

  async searchTrack(song, artist) {
    // Field filters + limit=10. Spotify 400s on limit>10 when field filters are
    // used, so 10 is a hard ceiling here.
    const q = artist ? `track:${song} artist:${artist}` : song;
    const data = await this.api('/v1/search', { query: { q, type: 'track', limit: '10' } });
    return (data && data.tracks && data.tracks.items) || [];
  }

  async getPlaybackState() {
    const data = await this.api('/v1/me/player');
    if (!data || !data.item) return { playing: false };
    return {
      playing: Boolean(data.is_playing),
      track: data.item.name,
      artists: (data.item.artists || []).map((a) => a.name),
      device: data.device ? data.device.name : null,
      volume: data.device ? data.device.volume_percent : null,
    };
  }

  async pushState() {
    if (!this.onState) return;
    try {
      this.onState(await this.getPlaybackState());
    } catch {
      /* state push is best-effort */
    }
  }

  async play(song, artist, query) {
    const device = await this.requireDevice();
    const tracks = await this.searchTrack(song, artist);
    const best = pickBestTrack(tracks, { song, artist, query });
    if (!best) throw new Error(`Couldn't find "${song}"${artist ? ` by ${artist}` : ''} on Spotify.`);
    await this.api('/v1/me/player/play', { method: 'PUT', query: { device_id: device.id }, body: { uris: [best.uri] } });
    await this.pushState();
    return { ok: true, action: 'play', track: best.name, artists: best.artists.map((a) => a.name), device: device.name };
  }

  async pause() {
    await this.api('/v1/me/player/pause', { method: 'PUT' });
    await this.pushState();
    return { ok: true, action: 'pause' };
  }

  async resume() {
    await this.api('/v1/me/player/play', { method: 'PUT' });
    await this.pushState();
    return { ok: true, action: 'resume' };
  }

  async next() {
    await this.api('/v1/me/player/next', { method: 'POST' });
    await this.pushState();
    return { ok: true, action: 'next' };
  }

  async previous() {
    await this.api('/v1/me/player/previous', { method: 'POST' });
    await this.pushState();
    return { ok: true, action: 'previous' };
  }

  async setVolumeRelative(direction) {
    const device = await this.requireDevice();
    const current = typeof device.volume_percent === 'number' ? device.volume_percent : 50;
    const next = Math.max(0, Math.min(100, current + direction * VOLUME_STEP));
    await this.api('/v1/me/player/volume', { method: 'PUT', query: { volume_percent: String(next), device_id: device.id } });
    await this.pushState();
    return { ok: true, action: 'volume', volume: next };
  }
}

/**
 * Execute a parsed Spotify command against a client. Central place so the
 * router stays thin; each branch pushes state to the UI via the client.
 *
 * @param {SpotifyClient} client
 * @param {object} parsed  from parseSpotifyCommand
 * @returns {Promise<object>}
 */
async function runSpotifyCommand(client, parsed) {
  if (!client || !client.isConnected()) {
    return { ok: false, error: 'Spotify is not connected. Run authorization first.' };
  }
  try {
    switch (parsed.kind) {
      case 'play':
        return await client.play(parsed.song, parsed.artist, parsed.query);
      case 'pause':
        return await client.pause();
      case 'resume':
        return await client.resume();
      case 'next':
        return await client.next();
      case 'previous':
        return await client.previous();
      case 'volumeUp':
        return await client.setVolumeRelative(+1);
      case 'volumeDown':
        return await client.setVolumeRelative(-1);
      default:
        return { ok: false, error: `Unknown Spotify command: ${parsed.kind}` };
    }
  } catch (err) {
    return { ok: false, action: parsed.kind, error: err.message };
  }
}

module.exports = {
  SCOPES,
  REDIRECT_URI,
  CALLBACK_PORT,
  // pure
  parseSpotifyCommand,
  scoreTrack,
  pickBestTrack,
  pickDevice,
  buildAuthorizeUrl,
  // persistence
  loadRefreshToken,
  saveRefreshToken,
  // oauth + client
  authorize,
  SpotifyClient,
  runSpotifyCommand,
};
