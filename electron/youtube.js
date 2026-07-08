'use strict';

/**
 * YouTube helpers for the Jarvis main process: build the privacy-embed URL,
 * build the search URL, scrape a search results page for the first video id.
 *
 * All the network-free logic (URL building, id extraction) is pure and tested;
 * searchYouTube() is the only thing that touches the network and it takes an
 * injectable fetch so it can be tested without hitting youtube.com.
 */

// The privacy-preserving embed host. postMessage commands must be targeted at
// this exact origin, so it lives in one place and is shared with the renderer.
const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

/**
 * Build the iframe src for a video. Format is fixed by spec:
 *   autoplay + JS API on, modest branding, no related videos, inline, controls.
 * `origin` must be the page's own origin (the loopback server address), which
 * YouTube checks against the parent frame — this is why the renderer can't be
 * served from file:// (that yields Error 153).
 *
 * @param {string} videoId  11-char YouTube id
 * @param {string} origin   e.g. "http://127.0.0.1:53421" (location.origin)
 * @returns {string}
 */
function buildEmbedUrl(videoId, origin) {
  return (
    `${EMBED_ORIGIN}/embed/${videoId}` +
    '?autoplay=1&enablejsapi=1&modestbranding=1&rel=0&playsinline=1&controls=1' +
    `&origin=${origin}`
  );
}

/**
 * Build the results URL. The `sp=EgIQAQ%3D%3D` param is YouTube's "Type: Video"
 * filter, so the first embedded id is a real video (not a channel/playlist).
 *
 * @param {string} query
 * @returns {string}
 */
function buildSearchUrl(query) {
  return (
    'https://www.youtube.com/results' +
    `?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D`
  );
}

/**
 * Pull the first video id out of a results page's embedded JSON (ytInitialData).
 * Ids are exactly 11 chars from [A-Za-z0-9_-]; the first `"videoId":"…"` on a
 * video-filtered results page is the top result.
 *
 * @param {string} html
 * @returns {string|null}
 */
function extractVideoId(html) {
  const match = String(html || '').match(/"videoId":"([A-Za-z0-9_-]{11})"/);
  return match ? match[1] : null;
}

/**
 * Search YouTube and return the first result's video id.
 *
 * @param {string} query
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]
 * @returns {Promise<string>} the video id
 * @throws if the request fails or no video is found
 */
async function searchYouTube(query, { fetchImpl = fetch } = {}) {
  const url = buildSearchUrl(query);
  const res = await fetchImpl(url, {
    headers: {
      // Look like a desktop browser so we get the full ytInitialData payload,
      // and skip the EU consent interstitial.
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: 'CONSENT=YES+1',
    },
  });
  if (!res.ok) {
    throw new Error(`YouTube search failed: HTTP ${res.status}`);
  }
  const html = await res.text();
  const videoId = extractVideoId(html);
  if (!videoId) {
    throw new Error(`No video found for "${query}".`);
  }
  return videoId;
}

module.exports = {
  EMBED_ORIGIN,
  buildEmbedUrl,
  buildSearchUrl,
  extractVideoId,
  searchYouTube,
};
