'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseVideoCommand,
  buildPlayerMessage,
  runVideoCommand,
} = require('../videoControl');

test('parseVideoCommand recognises a search', () => {
  assert.deepEqual(parseVideoCommand('play a video about jazz'), {
    kind: 'search',
    query: 'jazz',
  });
  assert.deepEqual(parseVideoCommand('find a video of the moon landing'), {
    kind: 'search',
    query: 'the moon landing',
  });
  assert.deepEqual(parseVideoCommand('search youtube for react hooks'), {
    kind: 'search',
    query: 'react hooks',
  });
});

test('parseVideoCommand distinguishes "play the video" (resume) from a search', () => {
  assert.deepEqual(parseVideoCommand('play the video'), { kind: 'resume' });
  assert.deepEqual(parseVideoCommand('resume the video'), { kind: 'resume' });
  assert.deepEqual(parseVideoCommand('pause the video'), { kind: 'pause' });
});

test('parseVideoCommand reads and clamps volume', () => {
  assert.deepEqual(parseVideoCommand('set volume to 40'), { kind: 'volume', value: 40 });
  assert.deepEqual(parseVideoCommand('volume 0'), { kind: 'volume', value: 0 });
  assert.deepEqual(parseVideoCommand('set the volume to 250'), { kind: 'volume', value: 100 });
});

test('parseVideoCommand returns null for non-video utterances', () => {
  assert.equal(parseVideoCommand('open calculator'), null);
  assert.equal(parseVideoCommand('what time is it'), null);
  assert.equal(parseVideoCommand(''), null);
});

test('buildPlayerMessage produces the YouTube iframe API payloads', () => {
  assert.deepEqual(buildPlayerMessage('pause'), { event: 'command', func: 'pauseVideo', args: [] });
  assert.deepEqual(buildPlayerMessage('resume'), { event: 'command', func: 'playVideo', args: [] });
  assert.deepEqual(buildPlayerMessage('volume', 55), { event: 'command', func: 'setVolume', args: [55] });
});

test('runVideoCommand: search resolves an id, builds the URL, and loads it', async () => {
  const loaded = [];
  const res = await runVideoCommand(
    { kind: 'search', query: 'jazz' },
    {
      searchImpl: async (q) => (q === 'jazz' ? 'VIDEOID1234' : null),
      sendLoad: (url) => loaded.push(url),
      sendCommand: () => assert.fail('search should not send a command'),
      origin: 'http://127.0.0.1:9000',
    },
  );
  assert.equal(res.ok, true);
  assert.equal(res.videoId, 'VIDEOID1234');
  assert.equal(loaded.length, 1);
  assert.ok(loaded[0].includes('/embed/VIDEOID1234?'));
  assert.ok(loaded[0].includes('origin=http://127.0.0.1:9000'));
});

test('runVideoCommand: control command posts a message, no search', async () => {
  const sent = [];
  const res = await runVideoCommand(
    { kind: 'pause' },
    {
      searchImpl: async () => assert.fail('control should not search'),
      sendLoad: () => assert.fail('control should not load'),
      sendCommand: (msg) => sent.push(msg),
      origin: 'http://127.0.0.1:9000',
    },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(sent[0], { event: 'command', func: 'pauseVideo', args: [] });
});
