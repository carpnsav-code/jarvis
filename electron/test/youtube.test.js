'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EMBED_ORIGIN,
  buildEmbedUrl,
  buildSearchUrl,
  extractVideoId,
  searchYouTube,
} = require('../youtube');

test('buildEmbedUrl matches the exact required format', () => {
  const url = buildEmbedUrl('dQw4w9WgXcQ', 'http://127.0.0.1:53421');
  assert.equal(
    url,
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' +
      '?autoplay=1&enablejsapi=1&modestbranding=1&rel=0&playsinline=1&controls=1' +
      '&origin=http://127.0.0.1:53421',
  );
});

test('embed uses the privacy (nocookie) host', () => {
  assert.equal(EMBED_ORIGIN, 'https://www.youtube-nocookie.com');
  assert.ok(buildEmbedUrl('x', 'o').startsWith('https://www.youtube-nocookie.com/'));
});

test('buildSearchUrl encodes the query and applies the video-only filter', () => {
  const url = buildSearchUrl('lofi jazz & chill');
  assert.ok(url.startsWith('https://www.youtube.com/results?search_query='));
  assert.ok(url.includes('lofi%20jazz%20%26%20chill'));
  assert.ok(url.endsWith('&sp=EgIQAQ%3D%3D'));
});

test('extractVideoId pulls the first 11-char id from embedded JSON', () => {
  const html = 'var ytInitialData = {"contents":{"videoRenderer":{"videoId":"abc123DEF_-","title":"x"}}};';
  assert.equal(extractVideoId(html), 'abc123DEF_-');
});

test('extractVideoId returns null when there is no video', () => {
  assert.equal(extractVideoId('<html>no results</html>'), null);
});

test('searchYouTube fetches and returns the first id', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      text: async () => '{"videoId":"ZZZ11119999"}',
    };
  };
  const id = await searchYouTube('cats', { fetchImpl: fakeFetch });
  assert.equal(id, 'ZZZ11119999');
  assert.ok(calls[0].url.includes('sp=EgIQAQ%3D%3D'));
});

test('searchYouTube throws on an HTTP error', async () => {
  const fakeFetch = async () => ({ ok: false, status: 429, text: async () => '' });
  await assert.rejects(() => searchYouTube('x', { fetchImpl: fakeFetch }), /HTTP 429/);
});

test('searchYouTube throws when no video is found', async () => {
  const fakeFetch = async () => ({ ok: true, text: async () => 'nothing here' });
  await assert.rejects(() => searchYouTube('x', { fetchImpl: fakeFetch }), /No video found/);
});
