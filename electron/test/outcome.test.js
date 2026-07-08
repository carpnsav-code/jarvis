'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { launchSpeech, videoSpeech, spotifySpeech, searchToContext } = require('../outcome');

test('launchSpeech confirms or reports the error', () => {
  assert.equal(launchSpeech({ ok: true, describe: 'Calculator' }), 'Opening Calculator.');
  assert.equal(launchSpeech({ ok: false, error: 'not found' }), 'not found');
});

test('videoSpeech maps each kind', () => {
  assert.equal(videoSpeech({ ok: true, kind: 'pause' }), 'Paused.');
  assert.equal(videoSpeech({ ok: true, kind: 'search' }), 'Here you go.');
  assert.equal(videoSpeech({ ok: false, error: 'x' }), 'x');
});

test('spotifySpeech names the track on play', () => {
  assert.equal(spotifySpeech({ ok: true, action: 'play', track: 'Blinding Lights', artists: ['The Weeknd'] }), 'Playing Blinding Lights by The Weeknd.');
  assert.equal(spotifySpeech({ ok: true, action: 'next' }), 'Skipping ahead.');
  assert.equal(spotifySpeech({ ok: true, action: 'volume', volume: 60 }), 'Volume 60 percent.');
});

test('searchToContext formats each source', () => {
  assert.match(searchToContext({ source: 'weather', location: 'Paris', description: 'Clear', tempC: 12, feelsLikeC: 10, humidity: 50 }), /Weather in Paris: Clear, 12/);
  assert.match(searchToContext({ source: 'market', symbol: 'BTC-USD', price: 65000, currency: 'USD', previousClose: 64000 }), /BTC-USD price: 65000 USD/);
  assert.match(searchToContext({ source: 'instagram', username: 'natgeo', fullName: 'Nat Geo', followers: 280000000 }), /natgeo \(Nat Geo\) has 280000000/);
  const web = searchToContext({ source: 'duckduckgo', query: 'cats', results: [{ title: 'A', snippet: 'a' }, { title: 'B', snippet: 'b' }] });
  assert.match(web, /Search results for "cats":/);
  assert.match(web, /1\. A — a/);
});

test('searchToContext is empty when there is nothing', () => {
  assert.equal(searchToContext({ source: 'none' }), '');
  assert.equal(searchToContext(null), '');
});
