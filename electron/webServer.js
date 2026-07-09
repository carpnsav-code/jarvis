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
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { loadApps, handleCommand } = require('./computerControl');
const { searchYouTube } = require('./youtube');
const { parseVideoCommand, runVideoCommand } = require('./videoControl');
const { search } = require('./webSearch');
const { searchGate } = require('./searchGate');
const { MemoryStore } = require('./memoryStore');
const { extractInBackground } = require('./memoryExtractor');
const missionLog = require('./missionLog');
const { GroqBrain, loadGroqKeys } = require('./groqBrain');
const elevenlabs = require('./elevenlabs');
const outcome = require('./outcome');
const { parseCreateCommand, createFile } = require('./fileCreation');
const { parseProductivityCommand, resolveProductivity } = require('./productivity');
const { loadKnowledge } = require('./knowledge');
const {
  parseSpotifyCommand,
  runSpotifyCommand,
  SpotifyClient,
  loadRefreshToken,
  saveRefreshToken,
  authorize: spotifyAuthorize,
} = require('./spotify');

const PORT = Number(process.env.JARVIS_PORT || 8800);
const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}:${PORT}`;
const GREETING = process.env.JARVIS_GREETING || 'JARVIS online. Say my name whenever you need me, sir.';

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

async function runSearch(text) {
  const gate = await searchGate(text);
  if (!gate.live) return { action: 'answer' };
  try {
    return { action: 'search', ...(await search(text)) };
  } catch (err) {
    return { action: 'search', source: 'none', error: err.message };
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

async function routeVoice(text) {
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
        origin: ORIGIN,
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
    const s = await runSearch(text);
    if (s.action === 'search') context = outcome.searchToContext(s);
  } else {
    if (LAUNCH_VERB.test(t)) {
      const launched = handleCommand({ action: text, target: text }, { apps });
      if (launched.ok) {
        out.speech = outcome.launchSpeech(launched);
        return out;
      }
    }
    const s = await runSearch(text);
    if (s.action === 'search') context = outcome.searchToContext(s);
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  try {
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
      const body = await readBody(req);
      const data = body ? JSON.parse(body) : {};
      if (url.pathname === '/api/voice') {
        const text = data.text || '';
        const result = await routeVoice(text);
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
});

server.listen(PORT, HOST, () => {
  const keys = loadGroqKeys().length;
  const voice = elevenlabs.isConfigured()
    ? 'ElevenLabs (British JARVIS voice) ✓'
    : 'browser fallback (robotic) — no ELEVENLABS_API_KEY found';
  // eslint-disable-next-line no-console
  console.log(
    `\n  ✦ Jarvis is running (web mode — no Electron needed).\n\n` +
      `    Open this in Chrome:   ${ORIGIN}\n\n` +
      `    Brain: ${keys ? `${keys} Groq key(s)` : 'no Groq key set — chat replies disabled'}\n` +
      `    Voice: ${voice}\n` +
      `    Press Ctrl+C here to stop.\n`,
  );
  missionLog.info(`web server on ${ORIGIN}`);
});
