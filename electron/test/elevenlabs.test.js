'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isConfigured, buildTtsRequest, synthesize } = require('../elevenlabs');

test('isConfigured needs only the key (voice id defaults to the JARVIS voice)', () => {
  assert.equal(isConfigured({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v' }), true);
  assert.equal(isConfigured({ ELEVENLABS_API_KEY: 'k' }), true);
  assert.equal(isConfigured({}), false);
});

test('synthesize uses the default JARVIS voice when none is set', async () => {
  let calledUrl = '';
  await synthesize('hi', {
    env: { ELEVENLABS_API_KEY: 'k' },
    fetchImpl: async (url) => {
      calledUrl = url;
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode('X').buffer };
    },
  });
  assert.ok(calledUrl.includes('onwK4e9ZLuTAKqWW03F9'));
});

test('buildTtsRequest targets the voice and sends the api key header', () => {
  const { url, options } = buildTtsRequest('hello', { voiceId: 'VID', apiKey: 'KEY' });
  assert.equal(url, 'https://api.elevenlabs.io/v1/text-to-speech/VID');
  assert.equal(options.headers['xi-api-key'], 'KEY');
  assert.equal(JSON.parse(options.body).text, 'hello');
});

test('synthesize returns null when not configured (Web Speech fallback)', async () => {
  const audio = await synthesize('hi', { env: {}, fetchImpl: async () => assert.fail('must not fetch') });
  assert.equal(audio, null);
});

test('synthesize returns a base64 data URI when configured', async () => {
  const audio = await synthesize('hi', {
    env: { ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v' },
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('MP3').buffer }),
  });
  assert.ok(audio.startsWith('data:audio/mpeg;base64,'));
});
