'use strict';

/**
 * Renderer: the voice loop with hard barge-in + the holographic UI hooks.
 *
 * Voice input — always-on Web Speech recognition with interim results. The
 * instant you start speaking while Jarvis is talking, he stops (barge-in). A
 * self-echo filter keeps his own voice (picked up by the mic) from either
 * barging in on himself or being sent back as a command.
 *
 * Voice output — ElevenLabs audio when the server provides it, else the Web
 * Speech voice. Playback is interruptible: barge-in cancels it immediately.
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

// --- Voice output (interruptible) ----------------------------------------------
let speakerMuted = false;
let speaking = false;
let currentAudio = null;
let speechDone = null; // resolver for the in-flight speak()
let lastSpokenWords = []; // for the echo filter
let echoGuardUntil = 0;

function words(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/** Is this transcript most likely Jarvis's own voice echoing back? */
function isEcho(transcript) {
  if (!speaking && Date.now() > echoGuardUntil) return false;
  const t = words(transcript);
  if (!t.length || !lastSpokenWords.length) return false;
  const spoken = new Set(lastSpokenWords);
  const overlap = t.filter((w) => spoken.has(w)).length / t.length;
  return overlap >= 0.5;
}

/** Stop any current speech immediately (barge-in / new turn). */
function stopSpeaking() {
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    } catch {
      /* ignore */
    }
    currentAudio = null;
  }
  window.speechSynthesis.cancel();
  speaking = false;
  if (speechDone) {
    const r = speechDone;
    speechDone = null;
    r();
  }
}

function speakWebSpeech(text) {
  return new Promise((resolve) => {
    const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
    let i = 0;
    const next = () => {
      if (!speaking || i >= sentences.length) return resolve();
      const u = new SpeechSynthesisUtterance(sentences[i].trim());
      const v = pickVoice();
      if (v) u.voice = v;
      u.rate = 0.9;
      u.pitch = 0.7;
      i += 1;
      u.onend = () => setTimeout(next, 200);
      u.onerror = () => setTimeout(next, 200);
      window.speechSynthesis.speak(u);
    };
    next();
  });
}
function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((v) => /(daniel|george|arthur|oliver)/i.test(v.name)) ||
    voices.find((v) => /en-GB/i.test(v.lang)) ||
    voices.find((v) => /male/i.test(v.name) && /en/i.test(v.lang)) ||
    voices.find((v) => /en/i.test(v.lang)) ||
    voices[0]
  );
}

async function speak(text) {
  if (!text) return;
  stopSpeaking();
  setState('speaking');
  lastSpokenWords = words(text);
  speaking = true;

  if (speakerMuted) {
    showText(text);
    speaking = false;
    echoGuardUntil = Date.now() + 1200;
    return;
  }

  let audio = null;
  try {
    ({ audio } = await window.jarvis.tts(text));
  } catch {
    audio = null;
  }
  if (!speaking) return; // barged-in while fetching audio

  if (audio) {
    await new Promise((resolve) => {
      speechDone = resolve;
      const el = new Audio(audio);
      currentAudio = el;
      el.addEventListener('playing', () => showText(text), { once: true });
      el.addEventListener('ended', () => {
        speechDone = null;
        resolve();
      }, { once: true });
      el.play().catch(() => {
        showText(text);
        speechDone = null;
        resolve();
      });
    });
  } else {
    showText(text);
    await speakWebSpeech(text);
  }

  speaking = false;
  currentAudio = null;
  echoGuardUntil = Date.now() + 1200;
}

// --- Send an utterance ----------------------------------------------------------
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

// --- Voice input: always-on recognition with barge-in --------------------------
const micBtn = document.getElementById('mic-toggle');
const speakerBtn = document.getElementById('speaker-toggle');
const bar = document.querySelector('.bar');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let micMuted = false;

function setListening(on) {
  const active = on && !micMuted;
  bar.classList.toggle('listening', active);
  if (active && stage.dataset.state === 'idle') setState('listening');
  if (!active && stage.dataset.state === 'listening') setState('idle');
}

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true; // needed to catch the *start* of your speech
  recognition.lang = 'en-US';

  recognition.onstart = () => setListening(true);
  recognition.onend = () => {
    setListening(false);
    if (!micMuted) {
      try {
        recognition.start();
      } catch {
        /* already starting */
      }
    }
  };
  recognition.onerror = () => setListening(false);

  recognition.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    const transcript = result[0].transcript.trim();
    if (!transcript) return;

    const echo = isEcho(transcript);

    // You started talking while Jarvis was speaking → he shuts up. Now.
    if (speaking && !echo) {
      stopSpeaking();
      setState('listening');
    }

    if (result.isFinal) {
      if (echo) return; // that was Jarvis's own voice — ignore it
      handleUtterance(transcript);
    }
  };

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
  if (speakerMuted) stopSpeaking();
});

// --- Startup greeting -----------------------------------------------------------
window.addEventListener('load', async () => {
  window.speechSynthesis.getVoices();
  const greeting = await window.jarvis.greeting();
  appendLog('jarvis', greeting);
  await speak(greeting);
  setState(micMuted ? 'idle' : 'listening');
});
