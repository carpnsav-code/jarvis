'use strict';

/**
 * Renderer: a hands-free conversation loop that works in EVERY browser
 * (Chrome, Safari, iPhone) — no Web Speech API dependency, no push-to-talk.
 *
 * One tap on the activation overlay (browsers require a single gesture to
 * unlock the mic + audio), then it's a natural loop:
 *
 *   listen → you speak (a WebAudio level meter detects it) → you pause →
 *   the recording goes to the server (Groq Whisper) → the brain answers →
 *   the reply plays → listen again.
 *
 * While Jarvis is speaking the mic is suspended, so he never hears himself —
 * that's what makes the loop stable at any volume.
 */

// --- UI state -------------------------------------------------------------------
const stage = document.getElementById('stage');
const stateLabel = document.getElementById('state-label');
const out = document.getElementById('out');
const log = document.getElementById('log');
const input = document.getElementById('utterance');
const overlay = document.getElementById('activate');

const STATE_LABELS = { idle: 'Standby', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking' };
function setState(state) {
  stage.dataset.state = state;
  if (stateLabel) stateLabel.textContent = STATE_LABELS[state] || 'Standby';
}
function showText(text) {
  if (out) out.textContent = text;
}
function appendLog(role, text) {
  const entry = document.createElement('div');
  entry.className = `entry ${role}`;
  entry.innerHTML = `<b>${role === 'you' ? 'You' : 'Jarvis'}</b><span></span>`;
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
window.jarvis.onPlayerLoad((url) => {
  playerReady = false;
  iframe.src = url;
});
iframe.addEventListener('load', () => {
  if (!iframe.src) return;
  setTimeout(() => {
    playerReady = true;
    while (pendingPlayer.length) postToPlayer(pendingPlayer.shift());
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
  nowPlaying.dataset.on = '1';
  nowPlaying.textContent =
    `${state.playing ? '▶' : '⏸'} ${state.track}${artists ? ' — ' + artists : ''}` +
    (state.volume != null ? `  ·  vol ${state.volume}%` : '');
}
window.jarvis.onSpotifyState(renderNowPlaying);
document.getElementById('spotify-auth').addEventListener('click', async () => {
  appendLog('jarvis', 'Opening Spotify authorization…');
  const res = await window.jarvis.spotifyAuthorize();
  if (res.ok) renderNowPlaying(await window.jarvis.spotifyState());
  else appendLog('jarvis', res.error || 'Spotify authorization failed.');
});

// --- Voice output ---------------------------------------------------------------
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
    audioPrimed = true;
  } catch {
    /* retried on the next gesture */
  }
  try {
    if (window.speechSynthesis) window.speechSynthesis.resume();
  } catch {
    /* ignore */
  }
}
document.addEventListener('pointerdown', () => primeAudio(), { capture: true });

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

let speakerMuted = false;
let speaking = false;
let speechResolve = null; // lets the Stop button resolve an in-flight speak()

function stopSpeaking() {
  try {
    player.pause();
    player.currentTime = 0;
  } catch {
    /* ignore */
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  speaking = false;
  if (speechResolve) {
    const r = speechResolve;
    speechResolve = null;
    r();
  }
}

/** Manual interrupt: shut him up and go straight back to listening. */
function interrupt() {
  if (!speaking) return;
  stopSpeaking();
  setState(micMuted ? 'idle' : 'listening');
  resumeListening();
}

function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((v) => /(daniel|george|arthur|oliver)/i.test(v.name)) ||
    voices.find((v) => /en-GB/i.test(v.lang)) ||
    voices.find((v) => /en/i.test(v.lang)) ||
    voices[0]
  );
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
      u.rate = 0.95;
      u.pitch = 0.75;
      i += 1;
      u.onend = () => setTimeout(next, 180);
      u.onerror = () => setTimeout(next, 180);
      window.speechSynthesis.speak(u);
    };
    next();
  });
}

/** Speak a reply. The mic is suspended for the duration so he never hears
 *  himself; listening resumes automatically right after. */
async function speak(text) {
  if (!text) return;
  stopSpeaking();
  suspendListening();
  speaking = true;
  setState('speaking');

  if (!speakerMuted) {
    let audio = null;
    try {
      ({ audio } = await window.jarvis.tts(text));
    } catch {
      audio = null;
    }
    if (speaking && audio) {
      await new Promise((resolve) => {
        speechResolve = resolve;
        const src = toPlayableUrl(audio);
        player.src = src;
        player.volume = 1.0;
        player.onplaying = () => showText(text);
        player.onended = () => {
          if (src.startsWith('blob:')) URL.revokeObjectURL(src);
          speechResolve = null;
          resolve();
        };
        player.onerror = () => {
          speechResolve = null;
          resolve();
        };
        player.play().catch(() => {
          appendLog('jarvis', '🔇 Tap the screen once to enable sound.');
          speechResolve = null;
          resolve();
        });
      });
    } else if (speaking) {
      showText(text);
      await speakWebSpeech(text);
    }
  } else {
    showText(text);
  }

  speaking = false;
  setState(micMuted ? 'idle' : 'listening');
  // Small pause so the audio tail in the room isn't picked up as speech.
  setTimeout(resumeListening, 350);
}

// --- Send an utterance ----------------------------------------------------------
async function handleUtterance(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  input.value = '';
  appendLog('you', trimmed);
  setState('thinking');
  try {
    const result = await window.jarvis.sendVoice(trimmed);
    appendLog('jarvis', result.speech);
    await speak(result.speech);
  } catch {
    appendLog('jarvis', '⚠️ Something went wrong on my end — say that again, sir.');
    setState(micMuted ? 'idle' : 'listening');
    resumeListening();
  }
}
document.getElementById('go').addEventListener('click', () => handleUtterance(input.value));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleUtterance(input.value);
});

// The Stop button — and tapping the hologram — cut him off instantly and put
// him back into listening.
document.getElementById('stop').addEventListener('click', interrupt);
stage.addEventListener('pointerdown', () => interrupt());

// --- Hands-free listening engine (WebAudio VAD + MediaRecorder + Whisper) --------
const micBtn = document.getElementById('mic-toggle');
const speakerBtn = document.getElementById('speaker-toggle');
const bar = document.querySelector('.bar');

let mediaStream = null;
let audioCtx = null;
let analyser = null;
let timeData = null;
let recorder = null;
let recChunks = [];
let engineOn = false; // mic initialised
let suspended = true; // not currently capturing (while he speaks / thinks)
let micMuted = false;
let discardNext = false;

let speechSeen = false;
let speechStart = 0;
let lastVoice = 0;
let recStarted = 0;
let noiseFloor = 0.01;

const MIN_SPEECH_MS = 300; // shorter = a cough/blip, ignored
const END_SILENCE_MS = 1500; // a full breath of silence before he takes the turn
const MAX_UTTER_MS = 30000; // hard cap per turn (long instructions fit)
const RECYCLE_MS = 20000; // restart an idle recorder so blobs stay small

function pickRecorderMime() {
  if (!window.MediaRecorder) return null;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mpeg'];
  if (MediaRecorder.isTypeSupported) {
    for (const m of candidates) if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function startRecorder() {
  if (!mediaStream || micMuted || !engineOn) return;
  recChunks = [];
  try {
    const mime = pickRecorderMime();
    recorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime }) : new MediaRecorder(mediaStream);
  } catch (err) {
    appendLog('jarvis', `⚠️ Recorder error (${err.name || 'unknown'}) — type below instead.`);
    return;
  }
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) recChunks.push(e.data);
  };
  recorder.onstop = () => {
    const chunks = recChunks;
    recChunks = [];
    if (discardNext) {
      discardNext = false;
      maybeRestart();
      return;
    }
    processUtterance(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
  };
  recorder.start(250);
  recStarted = Date.now();
  speechSeen = false;
  suspended = false;
  bar.classList.add('listening');
}

function maybeRestart() {
  if (engineOn && !suspended && !micMuted && (!recorder || recorder.state === 'inactive')) startRecorder();
}
function suspendListening() {
  suspended = true;
  bar.classList.remove('listening');
  speechSeen = false;
  if (recorder && recorder.state !== 'inactive') {
    discardNext = true; // whatever was in flight isn't a user turn
    try {
      recorder.stop();
    } catch {
      /* ignore */
    }
  }
}
function resumeListening() {
  if (!engineOn || micMuted) return;
  suspended = false;
  maybeRestart();
  if (!speaking) setState('listening');
}

async function processUtterance(blob) {
  suspended = true;
  bar.classList.remove('listening');
  if (blob.size < 1000) {
    resumeListening();
    return;
  }
  setState('thinking');
  try {
    const res = await fetch('/api/stt', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
    const { text } = await res.json();
    if (text && text.trim()) {
      await handleUtterance(text.trim()); // speak() resumes listening after
    } else {
      setState('listening');
      resumeListening();
    }
  } catch {
    appendLog('jarvis', '⚠️ Lost connection while transcribing — still listening.');
    setState('listening');
    resumeListening();
  }
}

function rms() {
  analyser.getByteTimeDomainData(timeData);
  let sum = 0;
  for (let i = 0; i < timeData.length; i++) {
    const v = (timeData[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / timeData.length);
}

// The heartbeat: watch the mic level, find the start and end of your speech.
setInterval(() => {
  if (!engineOn || suspended || micMuted || !analyser) return;
  if (!recorder || recorder.state !== 'recording') return;
  const level = rms();
  // Adapt the noise floor ONLY while idle — adapting during speech slowly
  // learns your voice as "background" and starts cutting you off mid-sentence.
  if (!speechSeen) noiseFloor = noiseFloor * 0.995 + level * 0.005;
  const startThreshold = Math.max(0.02, noiseFloor * 3);
  // Hysteresis: once you're talking, a much lower bar keeps counting as speech,
  // so quiet words and natural dips between words aren't mistaken for silence.
  const threshold = speechSeen ? startThreshold * 0.5 : startThreshold;
  const now = Date.now();

  if (level > threshold) {
    lastVoice = now;
    if (!speechSeen) {
      speechSeen = true;
      speechStart = now;
    }
  }

  if (speechSeen) {
    const spokeLongEnough = lastVoice - speechStart >= MIN_SPEECH_MS;
    if (now - lastVoice > END_SILENCE_MS || now - speechStart > MAX_UTTER_MS) {
      if (!spokeLongEnough) discardNext = true; // just a blip
      speechSeen = false;
      try {
        recorder.stop(); // → onstop → processUtterance / restart
      } catch {
        /* ignore */
      }
    }
  } else if (now - recStarted > RECYCLE_MS) {
    discardNext = true; // nothing said — restart to keep the blob small
    try {
      recorder.stop();
    } catch {
      /* ignore */
    }
  }
}, 60);

async function startEngine() {
  if (engineOn) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    appendLog('jarvis', '⚠️ This browser cannot record audio — type below instead.');
    return false;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    appendLog('jarvis', '🎤 Microphone is blocked. Tap the lock/aA icon in the address bar → allow Microphone → reload.');
    return false;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AC();
  try {
    await audioCtx.resume();
  } catch {
    /* ignore */
  }
  const src = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  timeData = new Uint8Array(analyser.fftSize);
  src.connect(analyser);
  engineOn = true;
  startRecorder();
  setState('listening');
  return true;
}

// --- Activation (the one tap browsers require) -----------------------------------
async function activate() {
  overlay.classList.add('hide');
  await primeAudio();
  const ok = await startEngine();
  const greeting = await window.jarvis.greeting();
  appendLog('jarvis', greeting + (ok ? '' : ' (Voice input unavailable — type below.)'));
  await speak(greeting);
}
overlay.addEventListener('click', activate, { once: true });

// --- Chips ------------------------------------------------------------------------
micBtn.addEventListener('click', () => {
  micMuted = !micMuted;
  setChip(micBtn, !micMuted, micMuted ? 'Mic off' : 'Mic on');
  if (micMuted) {
    suspendListening();
    setState('idle');
  } else {
    resumeListening();
    setState('listening');
  }
});
speakerBtn.addEventListener('click', () => {
  speakerMuted = !speakerMuted;
  setChip(speakerBtn, !speakerMuted, speakerMuted ? 'Speaker off' : 'Speaker on');
  if (speakerMuted) stopSpeaking();
});
