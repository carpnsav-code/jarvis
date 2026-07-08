'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isConfigured, buildTtsRequest, synthesize } = require('../elevenlabs');

test('isConfigured needs both key and voice id', () => {
  assert.equal(isConfigured({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v' }), true);
  assert.equal(isConfigured({ ELEVENLABS_API_KEY: 'k' }), false);
  assert.equal(isConfigured({}), false);
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
