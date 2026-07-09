'use strict';

/**
 * Web-server mode: run Jarvis as a local web app, no Electron required.
 *
 * Almost every module here is plain Node (no Electron), so we can host the same
 * UI and voice pipeline over a tiny HTTP server and open it in a browser. This
 * exists specifically to sidestep environments where Electron's binary can't be
 * downloaded — you just need Node.
 *
 *   node webServer.js   →   open the printed http://127.0.0.1:PORT in Chrome
 *
 * The browser does speech in/out (Web Speech API) and talks to this server via
 * fetch; the server does the brain (Groq), search, file creation, computer
 * control, and Spotify — keeping API keys off the page.
 */

require('./envLoader').loadEnv();

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { ensureCert } = require('./selfSignedCert');

const { loadApps, handleCommand } = require('./computerControl');
const { searchYouTube } = require('./youtube');
const { parseVideoCommand, runVideoCommand } = require('./videoControl');
const { search, classifyQuery } = require('./webSearch');
const { MemoryStore } = require('./memoryStore');
const { extractInBackground } = require('./memoryExtractor');
const missionLog = require('./missionLog');
const { GroqBrain, loadGroqKeys } = require('./groqBrain');
const elevenlabs = require('./elevenlabs');
const outcome = require('./outcome');
const { parseCreateCommand, createFile } = require('./fileCreation');
const { parseProductivityCommand, resolveProductivity } = require('./productivity');
const { loadKnowledge } = require('./knowledge');
const { GHLClient } = require('./ghlClient');
const { isGhlQuery, runGhlAgent } = require('./ghlAgent');
const {
  parseSpotifyCommand,
  runSpotifyCommand,
  SpotifyClient,
  loadRefreshToken,
  saveRefreshToken,
  authorize: spotifyAuthorize,
} = require('./spotify');

const crypto = require('crypto');

// Cloud hosts (Render, Railway, …) inject PORT; locally we default to 8800.
const IN_CLOUD = Boolean(process.env.PORT);
const PORT = Number(process.env.PORT || process.env.JARVIS_PORT || 8800);
const HOST = process.env.JARVIS_HOST || '0.0.0.0';
const ORIGIN = `http://127.0.0.1:${PORT}`;

// Optional password gate — protects a public deployment (which controls your
// CRM). Unset = open (fine for local). Set JARVIS_PASSWORD in the host's env.
const PASSWORD = process.env.JARVIS_PASSWORD || '';
const AUTH_TOKEN = PASSWORD ? crypto.createHash('sha256').update(`jarvis:${PASSWORD}`).digest('hex').slice(0, 32) : '';
function isAuthed(req) {
  if (!PASSWORD) return true;
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((c) => c.trim() === `jarvis_auth=${AUTH_TOKEN}`);
}
function loginPage() {
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0a0304;color:#ffd6d6;font-family:system-ui}
form{display:flex;flex-direction:column;gap:12px;width:260px}input,button{padding:12px;font-size:16px;border-radius:6px;border:1px solid #ff2b2b55;background:#1e0608;color:#ffd6d6}
button{background:#ff2b2b;color:#0a0304;font-weight:600;cursor:pointer}h1{letter-spacing:6px;color:#ff8a8a}</style>
<form onsubmit="event.preventDefault();fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:this.p.value})}).then(r=>r.json()).then(d=>d.ok?location.reload():alert('Wrong password'))">
<h1>J.A.R.V.I.S.</h1><input name=p type=password placeholder="Password" autofocus><button>Enter</button></form>`;
}
const GREETING = process.env.JARVIS_GREETING || 'Systems online. Say the word whenever you need me, sir.';

// This machine's LAN IP, for opening Jarvis on a phone.
function lanIp() {
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

// --- State ----------------------------------------------------------------------
let apps = [];
try {
  apps = loadApps(path.join(os.homedir(), '.jarvis', 'apps.json'));
} catch (err) {
  missionLog.error(`apps: ${err.message}`);
}
const memory = new MemoryStore();
let lastSpotifyState = null;
const spotify = new SpotifyClient({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  refreshToken: loadRefreshToken(),
  onState: (s) => {
    lastSpotifyState = s;
  },
});
const brain = new GroqBrain({
  keys: loadGroqKeys(),
  model: process.env.GROQ_MODEL,
  personality: process.env.GROQ_PERSONALITY,
  knowledge: loadKnowledge(),
  factsProvider: () => memory.factsContext(),
});
const ghl = new GHLClient();

function openUrl(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    execFile(cmd, [url]);
  } catch {
    /* best effort */
  }
}

// --- Routing (mirrors the Electron router, returns directives) -------------------
const QUESTION_LIKE =
  /^(who|what|whats|when|where|why|how|which|is|are|do|does|did|can|could|should|will)\b|\b(search|look up|lookup|google|find out|weather|forecast|price|news|followers)\b/;
// He only *acts* (launches an app / opens a site) on an explicit command verb —
// merely mentioning an app name never triggers it.
const LAUNCH_VERB = /\b(open|launch|start|run|go to|bring up|pull up|fire up)\b/;

// Cheap, no-AI decision: only hit the web when the question actually needs live
// data. Specialised types (weather/market/instagram) or explicit search words.
const WANTS_WEB = /\b(search|look up|lookup|google|latest|news|headlines|current|currently|today|right now|score|scores|stock|weather|forecast|price|followers|who won|how much)\b/;
async function searchContext(text) {
  const cls = classifyQuery(text);
  if (cls.type === 'web' && !WANTS_WEB.test(text.toLowerCase())) return '';
  try {
    return outcome.searchToContext(await search(text));
  } catch {
    return '';
  }
}

async function brainReply(text, context) {
  if (brain.isConfigured()) {
    try {
      return await brain.reply(text, { context });
    } catch (err) {
      missionLog.error(`brain: ${err.message}`);
      return context || "I'm having trouble reaching my brain right now.";
    }
  }
  if (context) return context;
  return "I can't answer that yet — add a Groq API key to give me a brain.";
}

async function runCreateFile(create) {
  const topic = create.topic || 'Untitled';
  const title = topic.replace(/^\w/, (c) => c.toUpperCase());
  let body = topic;
  if (create.kind !== 'note' && brain.isConfigured()) {
    try {
      body = await brain.reply(
        `Write the full text content for a ${create.kind} about: ${topic}. Return only the body.`,
        {},
      );
    } catch (err) {
      missionLog.error(`file: ${err.message}`);
    }
  }
  try {
    const r = createFile({ kind: create.kind, title, body });
    const noun = create.kind === 'pdf' ? 'PDF' : create.kind === 'note' ? 'note' : 'document';
    return `Saved your ${noun} to the Desktop.`;
  } catch (err) {
    missionLog.error(`file: ${err.message}`);
    return "I couldn't save that file.";
  }
}

async function routeVoice(text, pageOrigin = ORIGIN) {
  const out = { speech: '', playerUrl: null, playerCommand: null, spotifyState: null };
  lastSpotifyState = null;

  const video = parseVideoCommand(text);
  if (video) {
    try {
      const r = await runVideoCommand(video, {
        searchImpl: (q) => searchYouTube(q),
        sendLoad: (url) => {
          out.playerUrl = url;
        },
        sendCommand: (msg) => {
          out.playerCommand = msg;
        },
        origin: pageOrigin, // matches however the page was opened (localhost or phone IP)
      });
      out.speech = outcome.videoSpeech(r);
    } catch {
      out.speech = "I couldn't play that video.";
    }
    return out;
  }

  const music = parseSpotifyCommand(text);
  if (music) {
    const r = await runSpotifyCommand(spotify, music);
    out.speech = outcome.spotifySpeech(r);
    out.spotifyState = lastSpotifyState;
    return out;
  }

  const create = parseCreateCommand(text);
  if (create) {
    out.speech = await runCreateFile(create);
    return out;
  }

  // Live GoHighLevel operations ("what are my open deals", "text Sam …").
  if (isGhlQuery(text) && ghl.isConfigured()) {
    out.speech = await runGhlAgent(text, { keys: loadGroqKeys(), client: ghl });
    return out;
  }

  const prod = parseProductivityCommand(text);
  if (prod) {
    const { url, speech } = resolveProductivity(prod);
    openUrl(url);
    out.speech = speech;
    return out;
  }

  const t = String(text || '').trim().toLowerCase();
  let context = '';
  if (QUESTION_LIKE.test(t)) {
    context = await searchContext(text);
  } else {
    if (LAUNCH_VERB.test(t)) {
      const launched = handleCommand({ action: text, target: text }, { apps });
      if (launched.ok) {
        out.speech = outcome.launchSpeech(launched);
        return out;
      }
    }
    context = await searchContext(text);
  }
  out.speech = await brainReply(text, context);
  return out;
}

// --- HTTP plumbing --------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}
function readBodyBuffer(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** Transcribe an audio buffer via Groq Whisper (works for phones without the
 *  Web Speech API, e.g. iPhone). Returns '' if unavailable. */
async function transcribe(buf, contentType) {
  const keys = loadGroqKeys();
  if (!keys.length || !buf.length) return '';
  const ext = /mp4|m4a/.test(contentType) ? 'mp4' : /mpeg|mp3/.test(contentType) ? 'mp3' : /wav/.test(contentType) ? 'wav' : 'webm';
  for (const key of keys) {
    try {
      const form = new FormData();
      form.append('model', 'whisper-large-v3');
      form.append('file', new Blob([buf], { type: contentType || 'audio/webm' }), `audio.${ext}`);
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      if (res.status === 429 || res.status === 401 || res.status >= 500) continue;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()).text || '').trim();
    } catch (err) {
      missionLog.error(`stt: ${err.message}`);
    }
  }
  return '';
}
function sendJson(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function sendStatic(res, name, type) {
  try {
    res.writeHead(200, { 'Content-Type': type });
    res.end(fs.readFileSync(path.join(__dirname, name)));
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}
function sendIndex(res) {
  let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  // Inject the fetch-based bridge before the renderer (replaces Electron preload).
  html = html.replace(
    '<script src="renderer.js"></script>',
    '<script src="/webBridge.js"></script>\n    <script src="renderer.js"></script>',
  );
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const handler = async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  try {
    // Password gate (when JARVIS_PASSWORD is set).
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readBody(req);
      const pw = body ? (JSON.parse(body).password || '') : '';
      if (PASSWORD && pw === PASSWORD) {
        const secure = IN_CLOUD ? '; Secure' : '';
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `jarvis_auth=${AUTH_TOKEN}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax${secure}`,
        });
        return res.end('{"ok":true}');
      }
      return sendJson(res, { ok: false });
    }
    if (!isAuthed(req)) {
      // Static assets are harmless; the login page gates the rest.
      if (url.pathname === '/' || url.pathname === '/renderer.js' || url.pathname === '/webBridge.js') {
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(loginPage());
        }
        return sendStatic(res, url.pathname.slice(1), 'text/javascript');
      }
      res.writeHead(401);
      return res.end('Locked');
    }

    if (req.method === 'GET') {
      if (url.pathname === '/') return sendIndex(res);
      if (url.pathname === '/renderer.js') return sendStatic(res, 'renderer.js', 'text/javascript');
      if (url.pathname === '/webBridge.js') return sendStatic(res, 'webBridge.js', 'text/javascript');
      if (url.pathname === '/api/greeting') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(GREETING);
      }
      if (url.pathname === '/api/spotify/state') {
        const state = await spotify.getPlaybackState().catch(() => ({ playing: false }));
        return sendJson(res, state);
      }
    }
    if (req.method === 'POST') {
      // Speech-to-text takes a binary audio body — handle before JSON parsing.
      if (url.pathname === '/api/stt') {
        const buf = await readBodyBuffer(req);
        const text = await transcribe(buf, req.headers['content-type'] || '');
        return sendJson(res, { text });
      }
      const body = await readBody(req);
      const data = body ? JSON.parse(body) : {};
      if (url.pathname === '/api/voice') {
        const text = data.text || '';
        const pageOrigin = req.headers.host ? `http://${req.headers.host}` : ORIGIN;
        const result = await routeVoice(text, pageOrigin);
        memory.addTurn('user', text);
        memory.addTurn('assistant', result.speech);
        extractInBackground(memory, text, result.speech);
        return sendJson(res, result);
      }
      if (url.pathname === '/api/tts') {
        let audio = null;
        try {
          audio = await elevenlabs.synthesize(data.text || '');
        } catch (err) {
          missionLog.error(`tts: ${err.message}`);
        }
        return sendJson(res, { audio });
      }
      if (url.pathname === '/api/spotify/authorize') {
        if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
          return sendJson(res, { ok: false, error: 'Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET first.' });
        }
        try {
          const rt = await spotifyAuthorize({
            clientId: process.env.SPOTIFY_CLIENT_ID,
            clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
            openUrl,
          });
          saveRefreshToken(rt);
          spotify.refreshToken = rt;
          return sendJson(res, { ok: true });
        } catch (err) {
          return sendJson(res, { ok: false, error: err.message });
        }
      }
    }
    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    missionLog.error(`server: ${err.message}`);
    res.writeHead(500);
    res.end('Server error');
  }
};

const ip = lanIp();
const HTTPS_PORT = PORT + 1;
// Local self-signed https is only for LAN phone access; cloud hosts terminate
// TLS themselves, so skip it there.
const cert = IN_CLOUD ? null : ensureCert(ip);

http.createServer(handler).listen(PORT, HOST);
if (cert) {
  https.createServer({ key: cert.key, cert: cert.cert }, handler).listen(HTTPS_PORT, HOST);
}

const keys = loadGroqKeys().length;
const voice = elevenlabs.isConfigured()
  ? 'ElevenLabs (British JARVIS voice) ✓'
  : 'browser fallback (robotic) — no ELEVENLABS_API_KEY found';
const phoneLine = cert && ip
  ? `    On your phone:   https://${ip}:${HTTPS_PORT}   (same Wi-Fi — tap "advanced/proceed" past the warning)\n`
  : ip
    ? `    On your phone:   http://${ip}:${PORT}   (view/type only — no mic without https)\n`
    : '';
// eslint-disable-next-line no-console
console.log(
  `\n  ✦ Jarvis is running (web mode — no Electron needed).\n\n` +
    `    On this Mac:     ${ORIGIN}\n` +
    phoneLine +
    `\n    Brain: ${keys ? `${keys} Groq key(s)` : 'no Groq key set — chat replies disabled'}\n` +
    `    Voice: ${voice}\n` +
    `    Press Ctrl+C here to stop.\n`,
);
missionLog.info(`web server on ${ORIGIN}${cert ? ` + https:${HTTPS_PORT}` : ''}`);
