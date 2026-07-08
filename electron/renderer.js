'use strict';

/**
 * Renderer: the voice loop (guide Section 4) + the command-center UI + the
 * YouTube iframe relay.
 *
 * Voice input — always-on Web Speech recognition. Final transcripts go to the
 * main process (routed to a device command or the brain) and the spoken reply
 * is played back. The orb reflects state (standby / listening / thinking /
 * speaking) and the input bar pulses while listening.
 *
 * Voice output — ElevenLabs audio when the main process provides it, otherwise
 * the Web Speech API voice (deep male, rate 0.82, pitch 0.6, 250ms between
 * sentences). The reply text is revealed only once audio starts, so voice and
 * text feel synchronised.
 */

// --- UI state -------------------------------------------------------------------
const stage = document.getElementById('stage');
const stateLabel = document.getElementById('state-label');
const out = document.getElementById('out');
const log = document.getElementById('log');
const input = document.getElementById('utterance');

const STATE_LABELS = { idle: 'Standby', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking' };
function setState(state) {
  stage.dataset.state = state;
  stateLabel.textContent = STATE_LABELS[state] || 'Standby';
}
function showText(text) {
  out.textContent = text;
}
function appendLog(role, text) {
  const entry = document.createElement('div');
  entry.className = `entry ${role}`;
  const tag = role === 'you' ? 'You' : 'Jarvis';
  entry.innerHTML = `<b>${tag}</b><span></span>`;
  entry.querySelector('span').textContent = text;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}
function setChip(el, on, label) {
  el.classList.toggle('off', !on);
  el.innerHTML = `<span class="dot"></span> ${label}`;
}

// --- YouTube iframe relay -------------------------------------------------------
const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
const COMMAND_DELAY_MS = 700;

const iframe = document.getElementById('player');
let playerReady = false;
const pendingPlayer = [];

function postToPlayer(message) {
  if (!iframe.contentWindow) return;
  iframe.contentWindow.postMessage(JSON.stringify(message), EMBED_ORIGIN);
}
function flushPlayer() {
  while (pendingPlayer.length) postToPlayer(pendingPlayer.shift());
}
window.jarvis.onPlayerLoad((url) => {
  playerReady = false;
  iframe.src = url;
});
iframe.addEventListener('load', () => {
  if (!iframe.src) return;
  setTimeout(() => {
    playerReady = true;
    flushPlayer();
  }, COMMAND_DELAY_MS);
});
window.jarvis.onPlayerCommand((message) => {
  if (playerReady) postToPlayer(message);
  else pendingPlayer.push(message);
});

// --- Spotify now-playing --------------------------------------------------------
const nowPlaying = document.getElementById('nowplaying');
function renderNowPlaying(state) {
  if (!state || !state.track) {
    nowPlaying.dataset.on = '0';
    return;
  }
  const artists = (state.artists || []).join(', ');
  const icon = state.playing ? '▶' : '⏸';
  nowPlaying.dataset.on = '1';
  nowPlaying.textContent =
    `${icon} ${state.track}${artists ? ' — ' + artists : ''}` +
    (state.volume != null ? `  ·  vol ${state.volume}%` : '');
}
window.jarvis.onSpotifyState(renderNowPlaying);
document.getElementById('spotify-auth').addEventListener('click', async () => {
  showText('Opening Spotify authorization…');
  const res = await window.jarvis.spotifyAuthorize();
  if (res.ok) renderNowPlaying(await window.jarvis.spotifyState());
  else showText(res.error || 'Spotify authorization failed.');
});

// --- Voice output ---------------------------------------------------------------
let speakerMuted = false;

function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((v) => /male/i.test(v.name) && /en/i.test(v.lang)) ||
    voices.find((v) => /(daniel|alex|david|george|fred)/i.test(v.name)) ||
    voices.find((v) => /en/i.test(v.lang)) ||
    voices[0]
  );
}

function speakWebSpeech(text) {
  return new Promise((resolve) => {
    const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
    let i = 0;
    const next = () => {
      if (i >= sentences.length) return resolve();
      const u = new SpeechSynthesisUtterance(sentences[i].trim());
      const v = pickVoice();
      if (v) u.voice = v;
      u.rate = 0.82;
      u.pitch = 0.6;
      i += 1;
      u.onend = () => setTimeout(next, 250); // 250ms between sentences
      u.onerror = () => setTimeout(next, 250);
      window.speechSynthesis.speak(u);
    };
    next();
  });
}

/** Speak a reply; reveal text only once audio starts so the two stay in sync. */
async function speak(text) {
  if (!text) return;
  setState('speaking');
  if (speakerMuted) {
    showText(text);
    return;
  }

  let audio = null;
  try {
    ({ audio } = await window.jarvis.tts(text));
  } catch {
    audio = null;
  }

  if (audio) {
    const el = new Audio(audio);
    el.addEventListener('playing', () => showText(text), { once: true });
    await el.play().catch(() => showText(text));
    await new Promise((r) => el.addEventListener('ended', r, { once: true }));
  } else {
    showText(text);
    await speakWebSpeech(text);
  }
}

// --- Send an utterance through the assistant ------------------------------------
async function handleUtterance(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  input.value = '';
  appendLog('you', trimmed);
  setState('thinking');
  const result = await window.jarvis.sendVoice(trimmed);
  appendLog('jarvis', result.speech);
  await speak(result.speech);
  setState(micMuted ? 'idle' : 'listening');
}

document.getElementById('go').addEventListener('click', () => handleUtterance(input.value));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleUtterance(input.value);
});

// --- Voice input: always-on Web Speech recognition ------------------------------
const micBtn = document.getElementById('mic-toggle');
const speakerBtn = document.getElementById('speaker-toggle');
const bar = document.querySelector('.bar');

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let micMuted = false;

function setListening(on) {
  const active = on && !micMuted;
  bar.classList.toggle('listening', active);
  // Don't stomp on thinking/speaking states.
  if (active && stage.dataset.state === 'idle') setState('listening');
  if (!active && stage.dataset.state === 'listening') setState('idle');
}

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = 'en-US';

  recognition.onstart = () => setListening(true);
  recognition.onend = () => {
    setListening(false);
    if (!micMuted) {
      try {
        recognition.start(); // keep it always-on
      } catch {
        /* already starting */
      }
    }
  };
  recognition.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    if (result.isFinal) {
      const text = result[0].transcript.trim();
      if (text) handleUtterance(text);
    }
  };
  recognition.onerror = () => setListening(false);

  try {
    recognition.start();
  } catch {
    /* ignore */
  }
} else {
  setChip(micBtn, false, 'Mic N/A');
  micBtn.style.pointerEvents = 'none';
}

micBtn.addEventListener('click', () => {
  micMuted = !micMuted;
  setChip(micBtn, !micMuted, micMuted ? 'Mic off' : 'Mic on');
  setListening(!micMuted);
  if (!recognition) return;
  if (micMuted) recognition.stop();
  else {
    try {
      recognition.start();
    } catch {
      /* ignore */
    }
  }
});

speakerBtn.addEventListener('click', () => {
  speakerMuted = !speakerMuted;
  setChip(speakerBtn, !speakerMuted, speakerMuted ? 'Speaker off' : 'Speaker on');
  if (speakerMuted) window.speechSynthesis.cancel();
});

// --- Startup greeting -----------------------------------------------------------
window.addEventListener('load', async () => {
  window.speechSynthesis.getVoices(); // nudge async voice list
  const greeting = await window.jarvis.greeting();
  appendLog('jarvis', greeting);
  await speak(greeting);
  setState(micMuted ? 'idle' : 'listening');
});
