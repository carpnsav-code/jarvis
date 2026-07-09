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
// Auto-duck: he speaks at a reduced volume so the mic isn't saturated by his own
// voice and can pick up you talking over him (enabling reliable barge-in on
// speakers). Lower = easier to interrupt but quieter. Tune to taste.
const DUCK_VOLUME = 0.5;
let speakerMuted = false;

// One reusable audio element, "primed" on the first tap by actually playing a
// silent WAV — the reliable unlock so browsers (especially iPhone Safari) allow
// later programmatic playback. Without this, replies are silent.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const player = new Audio();
let audioPrimed = false;
async function primeAudio() {
  if (audioPrimed) return;
  try {
    player.src = SILENT_WAV;
    await player.play();
    player.pause();
    audioPrimed = true; // only mark primed once a real play succeeded
  } catch {
    /* no gesture yet — will retry on the next tap */
  }
  try {
    if (window.speechSynthesis) window.speechSynthesis.resume();
  } catch {
    /* ignore */
  }
}
// Not {once:true}: if the first attempt fails we retry on every tap until it works.
document.addEventListener('pointerdown', () => primeAudio(), { capture: true });

// Data-URI audio can be flaky on Safari; convert to a blob URL for playback.
function toPlayableUrl(dataUri) {
  try {
    const [meta, b64] = dataUri.split(',');
    const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'audio/mpeg';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([arr], { type: mime }));
  } catch {
    return dataUri;
  }
}
let speaking = false;
let currentAudio = null;
let speechDone = null; // resolver for the in-flight speak()
let lastSpokenWords = []; // for the echo filter
let echoGuardUntil = 0;
let cooldownUntil = 0; // just after he speaks: ignore his own echo tail

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
      u.volume = DUCK_VOLUME; // stay quiet enough to be talked over
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
    cooldownUntil = Date.now() + 700;
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
      const src = toPlayableUrl(audio);
      player.src = src;
      player.volume = DUCK_VOLUME; // ducked so you can talk over him
      currentAudio = player;
      player.onplaying = () => showText(text);
      player.onended = () => {
        if (src.startsWith('blob:')) URL.revokeObjectURL(src);
        speechDone = null;
        resolve();
      };
      player.play().catch(() => {
        appendLog('jarvis', '🔇 Tap the screen once to enable sound, then ask again.');
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
  cooldownUntil = Date.now() + 700; // ignore his own trailing echo
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

// While he's talking, the ONLY thing that stops him is his name — so loud
// background noise or his own voice can't cut him off. When he's idle you just
// talk to him normally (no wake word needed).
const WAKE = /\b(jarvis|jervis|jarvus|jarvods)\b/i;
function stripWake(text) {
  return text.replace(WAKE, '').replace(/^[\s,.:;!?-]+/, '').trim();
}

function setListening(on) {
  const active = on && !micMuted;
  bar.classList.toggle('listening', active);
  if (active && stage.dataset.state === 'idle') setState('listening');
  if (!active && stage.dataset.state === 'listening') setState('idle');
}

let recognizing = false;
function startRec() {
  if (recognizing || micMuted || !recognition) return;
  try {
    recognition.start();
  } catch {
    /* already started — fine */
  }
}

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true; // catch the start of your speech
  recognition.lang = 'en-US';

  recognition.onstart = () => {
    recognizing = true;
    setListening(true);
  };
  recognition.onend = () => {
    recognizing = false;
    setListening(false);
    if (!micMuted) startRec(); // Chrome stops it periodically — bring it back
  };
  recognition.onerror = () => {
    recognizing = false; // 'no-speech'/'aborted' are normal; watchdog restarts
  };

  recognition.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    const transcript = result[0].transcript.trim();
    if (!transcript) return;

    const hasWake = WAKE.test(transcript);
    // While he's talking, or in the brief cooldown right after, ignore
    // everything except his name — this stops his own voice/echo from ever
    // triggering a turn (the thing that breaks back-and-forth).
    const suppressed = speaking || Date.now() < cooldownUntil;
    if (suppressed && !hasWake) return;
    if (!suppressed && !hasWake && isEcho(transcript)) return;

    if (speaking) {
      stopSpeaking();
      setState('listening');
    }

    if (result.isFinal) {
      const command = hasWake ? stripWake(transcript) : transcript.trim();
      if (command) handleUtterance(command);
    }
  };

  startRec();
  // Watchdog: if recognition ever dies silently, restart it.
  setInterval(() => {
    if (!micMuted && !recognizing) startRec();
  }, 1500);
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
  else startRec();
});

speakerBtn.addEventListener('click', () => {
  speakerMuted = !speakerMuted;
  setChip(speakerBtn, !speakerMuted, speakerMuted ? 'Speaker off' : 'Speaker on');
  if (speakerMuted) stopSpeaking();
});

// --- Hold-to-talk (works on phones incl. iPhone, via server-side Whisper) -------
const talkBtn = document.getElementById('talk');
let mediaStream = null;
let recorder = null;
let recChunks = [];

function pickRecorderMime() {
  if (!window.MediaRecorder) return null;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mpeg'];
  if (MediaRecorder.isTypeSupported) {
    for (const m of candidates) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
  }
  return ''; // let the browser pick its default
}

async function startRecording() {
  primeAudio();
  stopSpeaking(); // pressing to talk interrupts him
  // Instant feedback the moment you tap — before the mic prompt resolves.
  isRecording = true;
  talkBtn.classList.add('recording');
  talkBtn.textContent = '● Starting…';
  setState('listening');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    appendLog('jarvis', '⚠️ This browser cannot record audio. On iPhone use Safari; on desktop use Chrome — or type below.');
    stopRecording();
    return;
  }
  try {
    if (!mediaStream) mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    appendLog('jarvis', '🎤 Microphone is blocked. Tap the lock/aA icon in the address bar → allow Microphone, then try again.');
    stopRecording();
    return;
  }
  recChunks = [];
  try {
    const mime = pickRecorderMime();
    recorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime }) : new MediaRecorder(mediaStream);
  } catch (err) {
    appendLog('jarvis', `⚠️ Recorder failed to start (${err.name || 'error'}). Try typing below instead.`);
    stopRecording();
    return;
  }
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) recChunks.push(e.data);
  };
  recorder.onstop = async () => {
    const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
    if (blob.size < 200) {
      appendLog('jarvis', "I didn't catch any audio — hold the button and speak, then tap Stop.");
      setState(micMuted ? 'idle' : 'listening');
      return;
    }
    setState('thinking');
    try {
      const res = await fetch('/api/stt', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
      const { text } = await res.json();
      if (text && text.trim()) handleUtterance(text.trim());
      else {
        appendLog('jarvis', "I couldn't make that out — try again a bit closer to the mic.");
        setState(micMuted ? 'idle' : 'listening');
      }
    } catch {
      appendLog('jarvis', '⚠️ Lost connection to the server — check the internet and try again.');
      setState(micMuted ? 'idle' : 'listening');
    }
  };
  // Timeslice so iOS Safari actually flushes chunks while recording.
  recorder.start(250);
  talkBtn.textContent = '■ Stop & send';
  setState('listening');
}
function stopRecording() {
  isRecording = false;
  talkBtn.classList.remove('recording');
  talkBtn.textContent = '🎤 Start talking';
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}
// Tap to start listening (interrupts him if he's talking), tap again to send.
let isRecording = false;
talkBtn.addEventListener('click', () => {
  if (isRecording) stopRecording();
  else startRecording();
});

// --- Startup greeting -----------------------------------------------------------
window.addEventListener('load', async () => {
  window.speechSynthesis.getVoices();
  const greeting = await window.jarvis.greeting();
  appendLog('jarvis', greeting);
  await speak(greeting);
  setState(micMuted ? 'idle' : 'listening');
});
