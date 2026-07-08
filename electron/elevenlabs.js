'use strict';

/**
 * ElevenLabs voice output (guide Section 4, Step 3).
 *
 * The main process fetches the audio (keeping ELEVENLABS_API_KEY out of the
 * renderer) and hands the renderer base64 MP3 to play. When no key/voice is
 * configured, synthesize() returns null and the renderer falls back to the Web
 * Speech API voice — so voice output always works, keyless.
 *
 * fetch is injectable for testing the request shape without the network.
 */

const ELEVEN_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_MODEL = 'eleven_turbo_v2';

function isConfigured(env = process.env) {
  return Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID);
}

/**
 * Build the request for ElevenLabs TTS.
 * @param {string} text
 * @param {{voiceId:string, apiKey:string, model?:string}} opts
 * @returns {{url:string, options:object}}
 */
function buildTtsRequest(text, { voiceId, apiKey, model = DEFAULT_MODEL }) {
  return {
    url: `${ELEVEN_BASE}/${voiceId}`,
    options: {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
  };
}

/**
 * Synthesize speech. Returns a data URI (base64 MP3) the renderer can play, or
 * null when ElevenLabs isn't configured.
 *
 * @param {string} text
 * @param {object} [deps]
 * @returns {Promise<string|null>}
 */
async function synthesize(text, { env = process.env, fetchImpl = fetch } = {}) {
  if (!isConfigured(env)) return null;
  const { url, options } = buildTtsRequest(text, {
    voiceId: env.ELEVENLABS_VOICE_ID,
    apiKey: env.ELEVENLABS_API_KEY,
    model: env.ELEVENLABS_MODEL,
  });
  const res = await fetchImpl(url, options);
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:audio/mpeg;base64,${buf.toString('base64')}`;
}

module.exports = { isConfigured, buildTtsRequest, synthesize, DEFAULT_MODEL };
