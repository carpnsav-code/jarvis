'use strict';

/**
 * Renderer: the voice loop (guide Section 4) + the YouTube iframe relay.
 *
 * Voice input — always-on Web Speech recognition. On a final transcript it goes
 * to the main process (which routes it to a device command or the brain) and
 * the spoken reply is played back. A mic mute button stops listening; the input
 * bar pulses while actively listening.
 *
 * Voice output — ElevenLabs audio when the main process provides it, otherwise
 * the Web Speech API voice (deep male, rate 0.82, pitch 0.6, a 250ms gap between
 * sentences). Per the guide, the reply text is only revealed once audio starts,
 * so voice and text feel synchronised. A speaker button mutes output.
 */

// --- YouTube iframe relay (unchanged behaviour) --------------------------------
const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
const COMMAND_DELAY_MS = 700;

const iframe = document.getElementById('player');
const out = document.getElementById('out');
const input = document.getElementById('utterance');

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
    nowPlaying.hidden = true;
    return;
  }
  const artists = (state.artists || []).join(', ');
  const icon = state.playing ? '▶' : '⏸';
  nowPlaying.hidden = false;
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

function showText(text) {
  out.textContent = text;
}

function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  // Prefer a deep male English voice.
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
      // 250ms pause between sentences.
      u.onend = () => setTimeout(next, 250);
      u.onerror = () => setTimeout(next, 250);
      window.speechSynthesis.speak(u);
    };
    next();
  });
}

/**
 * Speak a reply. Reveal the text only once audio actually starts, so the two
 * stay in sync. Uses ElevenLabs audio when the main process supplies it.
 */
async function speak(text) {
  if (!text) return;
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
    // Web Speech: reveal text as playback begins.
    showText(text);
    await speakWebSpeech(text);
  }
}

// --- Send an utterance through the assistant ------------------------------------
async function handleUtterance(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  input.value = '';
  const result = await window.jarvis.sendVoice(trimmed);
  await speak(result.speech);
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
  bar.classList.toggle('listening', on && !micMuted);
}

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = 'en-US';

  recognition.onstart = () => setListening(true);
  recognition.onend = () => {
    setListening(false);
    // Keep it always-on: restart unless the user muted the mic.
    if (!micMuted) {
      try {
        recognition.start();
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

  if (!micMuted) {
    try {
      recognition.start();
    } catch {
      /* ignore */
    }
  }
} else {
  micBtn.disabled = true;
  micBtn.textContent = '🎤 (unavailable)';
}

micBtn.addEventListener('click', () => {
  micMuted = !micMuted;
  micBtn.textContent = micMuted ? '🔇 Mic off' : '🎤 Mic on';
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
  speakerBtn.textContent = speakerMuted ? '🔈 Speaker off' : '🔊 Speaker on';
  if (speakerMuted) window.speechSynthesis.cancel();
});

// --- Startup greeting -----------------------------------------------------------
window.addEventListener('load', async () => {
  // Voice list can load asynchronously; nudge it.
  window.speechSynthesis.getVoices();
  const greeting = await window.jarvis.greeting();
  await speak(greeting);
});
