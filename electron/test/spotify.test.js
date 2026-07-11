'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSpotifyCommand,
  scoreTrack,
  pickBestTrack,
  pickDevice,
  buildAuthorizeUrl,
  SCOPES,
  SpotifyClient,
  runSpotifyCommand,
} = require('../spotify');

// --- parsing --------------------------------------------------------------------

test('parseSpotifyCommand reads "play X by Y"', () => {
  assert.deepEqual(
    { ...parseSpotifyCommand('play blinding lights by the weeknd'), query: undefined },
    { kind: 'play', song: 'blinding lights', artist: 'the weeknd', query: undefined },
  );
});

test('parseSpotifyCommand handles transport + volume verbs', () => {
  assert.equal(parseSpotifyCommand('next song').kind, 'next');
  assert.equal(parseSpotifyCommand('skip').kind, 'next');
  assert.equal(parseSpotifyCommand('previous track').kind, 'previous');
  assert.equal(parseSpotifyCommand('volume up').kind, 'volumeUp');
  assert.equal(parseSpotifyCommand('turn it down').kind, 'volumeDown');
});

test('parseSpotifyCommand only takes music-qualified pause/resume', () => {
  assert.equal(parseSpotifyCommand('pause the music').kind, 'pause');
  assert.equal(parseSpotifyCommand('resume the song').kind, 'resume');
  assert.equal(parseSpotifyCommand('pause'), null); // left to the video player
  assert.equal(parseSpotifyCommand('what time is it'), null);
});

// --- scoring --------------------------------------------------------------------

const tracks = [
  { name: 'Blinding Lights', uri: 'a', popularity: 90, artists: [{ name: 'The Weeknd' }] },
  { name: 'Blinding Lights - Live', uri: 'b', popularity: 60, artists: [{ name: 'The Weeknd' }] },
  { name: 'Blinding Lights (Cover)', uri: 'c', popularity: 95, artists: [{ name: 'Some Cover Band' }] },
];

test('scoreTrack prioritises exact artist and penalises unrequested variants', () => {
  const want = { song: 'blinding lights', artist: 'the weeknd', query: 'blinding lights by the weeknd' };
  assert.ok(scoreTrack(tracks[0], want) > scoreTrack(tracks[1], want)); // studio > live
  assert.ok(scoreTrack(tracks[0], want) > scoreTrack(tracks[2], want)); // real artist > popular cover
});

test('pickBestTrack returns the studio original, not the more popular cover', () => {
  const best = pickBestTrack(tracks, { song: 'blinding lights', artist: 'the weeknd', query: 'blinding lights by the weeknd' });
  assert.equal(best.uri, 'a');
});

test('pickBestTrack keeps a live version when the user asked for it', () => {
  const best = pickBestTrack(tracks, { song: 'blinding lights', artist: 'the weeknd', query: 'blinding lights live by the weeknd' });
  assert.equal(best.uri, 'b');
});

// --- device selection -----------------------------------------------------------

test('pickDevice prefers the active device, else the first', () => {
  assert.equal(pickDevice([{ id: '1', is_active: false }, { id: '2', is_active: true }]).id, '2');
  assert.equal(pickDevice([{ id: '1', is_active: false }, { id: '2', is_active: false }]).id, '1');
  assert.equal(pickDevice([]), null);
});

// --- authorize url --------------------------------------------------------------

test('buildAuthorizeUrl includes all three required scopes and the redirect', () => {
  const url = buildAuthorizeUrl('CID', 'http://127.0.0.1:8888/callback');
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('client_id'), 'CID');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'http://127.0.0.1:8888/callback');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  for (const scope of SCOPES) assert.ok(parsed.searchParams.get('scope').includes(scope));
});

// --- cloud oauth: code exchange --------------------------------------------------

test('exchangeCode posts the code + redirect and returns only the refresh token', async () => {
  const { exchangeCode } = require('../spotify');
  const calls = [];
  const rt = await exchangeCode({
    clientId: 'CID',
    clientSecret: 'SEC',
    code: 'THECODE',
    redirectUri: 'https://jarvis.example.com/api/spotify/callback',
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ access_token: 'AT', refresh_token: 'RT-1' }) };
    },
  });
  assert.equal(rt, 'RT-1');
  assert.ok(calls[0].url.includes('/api/token'));
  const body = new URLSearchParams(calls[0].opts.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'THECODE');
  assert.equal(body.get('redirect_uri'), 'https://jarvis.example.com/api/spotify/callback');
  // client id/secret ride in the Basic auth header, never the body
  assert.match(calls[0].opts.headers.Authorization, /^Basic /);
});

test('exchangeCode throws on a failed exchange or a missing refresh token', async () => {
  const { exchangeCode } = require('../spotify');
  await assert.rejects(
    () => exchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r', fetchImpl: async () => ({ ok: false, status: 400 }) }),
    /HTTP 400/
  );
  await assert.rejects(
    () => exchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r', fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'AT' }) }) }),
    /no refresh token/
  );
});

test('loadRefreshToken falls back to SPOTIFY_REFRESH_TOKEN when no file exists', () => {
  const { loadRefreshToken } = require('../spotify');
  const prev = process.env.SPOTIFY_REFRESH_TOKEN;
  process.env.SPOTIFY_REFRESH_TOKEN = 'ENV-RT';
  try {
    assert.equal(loadRefreshToken('/nonexistent/path/spotify.json'), 'ENV-RT');
  } finally {
    if (prev === undefined) delete process.env.SPOTIFY_REFRESH_TOKEN;
    else process.env.SPOTIFY_REFRESH_TOKEN = prev;
  }
});

// --- client: token refresh ------------------------------------------------------

function tokenFetch(record) {
  return async (url, opts) => {
    record.push({ url, opts });
    if (url.includes('/api/token')) {
      return { ok: true, json: async () => ({ access_token: 'AT-' + record.length, expires_in: 3600 }) };
    }
    throw new Error('unexpected ' + url);
  };
}

test('ensureAccessToken refreshes once, then reuses within the buffer', async () => {
  const record = [];
  const client = new SpotifyClient({ clientId: 'i', clientSecret: 's', refreshToken: 'r', fetchImpl: tokenFetch(record) });
  const now = 1_000_000;
  const t1 = await client.ensureAccessToken(now);
  const t2 = await client.ensureAccessToken(now + 60_000); // well within the hour
  assert.equal(t1, t2);
  assert.equal(record.length, 1); // only one refresh call
});

test('ensureAccessToken refreshes again once inside the 30s buffer', async () => {
  const record = [];
  const client = new SpotifyClient({ clientId: 'i', clientSecret: 's', refreshToken: 'r', fetchImpl: tokenFetch(record) });
  const now = 1_000_000;
  await client.ensureAccessToken(now);
  // Jump to 20s before expiry (inside the 30s buffer) → must refresh again.
  await client.ensureAccessToken(now + 3600_000 - 20_000);
  assert.equal(record.length, 2);
});

// --- client: search + device + play --------------------------------------------

function apiFetch(handlers) {
  return async (url, opts) => {
    if (url.includes('/api/token')) return { ok: true, json: async () => ({ access_token: 'AT', expires_in: 3600 }) };
    for (const [needle, fn] of handlers) {
      if (url.includes(needle)) return fn(url, opts);
    }
    throw new Error('unhandled ' + url);
  };
}

test('searchTrack requests limit=10 with field filters', async () => {
  let seen = '';
  const client = new SpotifyClient({
    clientId: 'i', clientSecret: 's', refreshToken: 'r',
    fetchImpl: apiFetch([
      ['/v1/search', (url) => { seen = url; return { ok: true, status: 200, text: async () => JSON.stringify({ tracks: { items: tracks } }) }; }],
    ]),
  });
  const items = await client.searchTrack('blinding lights', 'the weeknd');
  assert.equal(items.length, 3);
  const params = new URL(seen).searchParams;
  assert.equal(params.get('limit'), '10');
  assert.equal(params.get('q'), 'track:blinding lights artist:the weeknd');
});

test('requireDevice throws a clear message when no device exists', async () => {
  const client = new SpotifyClient({
    clientId: 'i', clientSecret: 's', refreshToken: 'r',
    fetchImpl: apiFetch([['/v1/me/player/devices', () => ({ ok: true, status: 200, text: async () => JSON.stringify({ devices: [] }) })]]),
  });
  await assert.rejects(() => client.requireDevice(), /Open Spotify on any device first/);
});

test('play picks a device, searches, plays the best uri, and pushes state', async () => {
  const states = [];
  const puts = [];
  const client = new SpotifyClient({
    clientId: 'i', clientSecret: 's', refreshToken: 'r',
    onState: (s) => states.push(s),
    fetchImpl: apiFetch([
      ['/v1/me/player/devices', () => ({ ok: true, status: 200, text: async () => JSON.stringify({ devices: [{ id: 'D1', is_active: true, volume_percent: 50, name: 'Phone' }] }) })],
      ['/v1/search', () => ({ ok: true, status: 200, text: async () => JSON.stringify({ tracks: { items: tracks } }) })],
      ['/v1/me/player/play', (url, opts) => { puts.push(JSON.parse(opts.body)); return { ok: true, status: 204, text: async () => '' }; }],
      ['/v1/me/player', () => ({ ok: true, status: 200, text: async () => JSON.stringify({ is_playing: true, item: { name: 'Blinding Lights', artists: [{ name: 'The Weeknd' }] }, device: { name: 'Phone', volume_percent: 50 } }) })],
    ]),
  });
  const res = await client.play('blinding lights', 'the weeknd', 'blinding lights by the weeknd');
  assert.equal(res.ok, true);
  assert.deepEqual(puts[0], { uris: ['a'] }); // studio original
  assert.equal(states.length, 1);
  assert.equal(states[0].track, 'Blinding Lights');
});

test('runSpotifyCommand reports a clear error when not connected', async () => {
  const client = new SpotifyClient({}); // no creds
  const res = await runSpotifyCommand(client, { kind: 'next' });
  assert.equal(res.ok, false);
  assert.match(res.error, /not connected/i);
});
