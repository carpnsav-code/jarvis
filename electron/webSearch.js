'use strict';

/**
 * Web search for the assistant — a layered fallback chain that needs no API
 * keys for the baseline, plus specialised sources for a few query shapes.
 *
 * General web query:
 *   Layer 1  DuckDuckGo HTML scrape (keyless).
 *   Layer 2  Brave Search API — only if a key is configured.
 *   Layer 3  TechCrunch's AI feed — last resort, and only for AI-news queries.
 *
 * Specialised (checked first, by query shape):
 *   weather   → wttr.in ?format=j1 (structured JSON)
 *   market    → Yahoo Finance chart API (BTC, ETH, S&P 500)
 *   instagram → i.instagram.com web profile API (follower count)
 *
 * Every outbound request carries the exact desktop User-Agent below. Without it
 * DuckDuckGo serves a bot-detection page and Instagram answers 401. The network
 * calls take an injectable fetch so the whole thing is testable offline.
 *
 * We deliberately never touch the DuckDuckGo Instant Answer API
 * (api.duckduckgo.com) — it returns nothing useful for real queries.
 */

// Required verbatim — see the module note above.
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const INSTAGRAM_APP_ID = '936619743392459'; // public web app id used by instagram.com
const TECHCRUNCH_AI_FEED = 'https://techcrunch.com/category/artificial-intelligence/feed/';

// Yahoo Finance symbols for the assets we support.
const MARKET_SYMBOLS = {
  btc: 'BTC-USD',
  bitcoin: 'BTC-USD',
  eth: 'ETH-USD',
  ethereum: 'ETH-USD',
  sp500: '^GSPC',
  'sp 500': '^GSPC',
  'snp 500': '^GSPC',
  'standard and poors': '^GSPC',
};

function headers(extra = {}) {
  return {
    'User-Agent': DESKTOP_UA,
    'Accept-Language': 'en-US,en;q=0.9',
    ...extra,
  };
}

// --- HTML/entity helpers --------------------------------------------------------

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#(?:x27|039|39);/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;|&#47;/g, '/')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// DuckDuckGo's HTML endpoint wraps outbound links as /l/?uddg=<encoded-url>.
function decodeDdgHref(href) {
  const m = String(href || '').match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  return href;
}

// --- Layer 1: DuckDuckGo HTML scrape --------------------------------------------

/**
 * Parse the DuckDuckGo HTML results page. Titles/links come from `result__a`
 * anchors and snippets from `result__snippet`, matched positionally.
 *
 * @param {string} html
 * @returns {Array<{title:string,url:string,snippet:string}>}
 */
function parseDuckDuckGo(html) {
  const linkRe =
    /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe =
    /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const links = [];
  let m;
  while ((m = linkRe.exec(html))) {
    links.push({ url: decodeDdgHref(m[1]), title: stripTags(m[2]) });
  }
  const snippets = [];
  while ((m = snippetRe.exec(html))) snippets.push(stripTags(m[1]));

  const out = [];
  for (let i = 0; i < links.length; i++) {
    if (!links[i].title) continue;
    out.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] || '' });
  }
  return out;
}

async function scrapeDuckDuckGo(query, { fetchImpl = fetch } = {}) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchImpl(url, {
    headers: headers({ 'Cache-Control': 'no-cache' }),
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  return parseDuckDuckGo(await res.text());
}

// --- Layer 2: Brave Search API (optional) ---------------------------------------

async function braveSearch(query, { fetchImpl = fetch, braveApiKey = process.env.BRAVE_API_KEY } = {}) {
  if (!braveApiKey) return [];
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
  const res = await fetchImpl(url, {
    headers: headers({ Accept: 'application/json', 'X-Subscription-Token': braveApiKey }),
  });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const data = await res.json();
  const results = data && data.web && Array.isArray(data.web.results) ? data.web.results : [];
  return results.map((r) => ({ title: r.title, url: r.url, snippet: r.description || '' }));
}

// --- Layer 3: TechCrunch AI feed (last resort, AI-news queries) -----------------

function parseRss(xml) {
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  const field = (block, name) => {
    const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`));
    return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1') : '';
  };
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = stripTags(field(block, 'title'));
    if (!title) continue;
    items.push({
      title,
      url: stripTags(field(block, 'link')),
      snippet: stripTags(field(block, 'description')),
    });
  }
  return items;
}

async function techCrunchAiNews({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl(TECHCRUNCH_AI_FEED, { headers: headers() });
  if (!res.ok) throw new Error(`TechCrunch HTTP ${res.status}`);
  return parseRss(await res.text());
}

// --- Specialised sources --------------------------------------------------------

async function getWeather(location, { fetchImpl = fetch } = {}) {
  const loc = location ? encodeURIComponent(location) : '';
  const res = await fetchImpl(`https://wttr.in/${loc}?format=j1`, { headers: headers() });
  if (!res.ok) throw new Error(`wttr.in HTTP ${res.status}`);
  const data = await res.json();
  const cur = data && Array.isArray(data.current_condition) ? data.current_condition[0] : null;
  if (!cur) throw new Error('No weather data.');
  const area =
    (data.nearest_area && data.nearest_area[0] && data.nearest_area[0].areaName &&
      data.nearest_area[0].areaName[0] &&
      data.nearest_area[0].areaName[0].value) ||
    location ||
    'your area';
  return {
    location: area,
    description: cur.weatherDesc && cur.weatherDesc[0] ? cur.weatherDesc[0].value : '',
    tempC: Number(cur.temp_C),
    tempF: Number(cur.temp_F),
    feelsLikeC: Number(cur.FeelsLikeC),
    humidity: Number(cur.humidity),
  };
}

async function getMarketPrice(symbol, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
    { headers: headers() },
  );
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const data = await res.json();
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result || !result.meta) throw new Error(`No market data for ${symbol}.`);
  const meta = result.meta;
  return {
    symbol,
    price: meta.regularMarketPrice,
    currency: meta.currency,
    previousClose: meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose,
  };
}

async function getInstagramFollowers(username, { fetchImpl = fetch } = {}) {
  const handle = String(username || '').replace(/^@/, '');
  const res = await fetchImpl(
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`,
    {
      // The App-Id header + desktop UA are what make this endpoint answer 200
      // instead of 401.
      headers: headers({ 'X-IG-App-ID': INSTAGRAM_APP_ID, Accept: 'application/json' }),
    },
  );
  if (!res.ok) throw new Error(`Instagram HTTP ${res.status}`);
  const data = await res.json();
  const user = data && data.data && data.data.user;
  if (!user) throw new Error(`No Instagram user "${handle}".`);
  return {
    username: handle,
    fullName: user.full_name || '',
    followers: user.edge_followed_by ? user.edge_followed_by.count : null,
  };
}

// --- Query classification -------------------------------------------------------

function normalise(q) {
  return String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function detectMarketSymbol(q) {
  if (/\bbitcoins?\b|\bbtc\b/.test(q)) return MARKET_SYMBOLS.btc;
  if (/\bethereums?\b|\beth\b/.test(q)) return MARKET_SYMBOLS.eth;
  if (/\bs&p\s*500\b|\bs and p 500\b|\bsp\s*500\b|\bsnp\s*500\b/.test(q)) return MARKET_SYMBOLS.sp500;
  return null;
}

function extractInstagramHandle(q) {
  const patterns = [
    /@([a-z0-9._]+)/,
    /followers?\s+(?:of|for)\s+@?([a-z0-9._]+)/,
    /(?:does|do)\s+@?([a-z0-9._]+)\s+have/,
    /@?([a-z0-9._]+)(?:'s)?\s+instagram/,
    /instagram\s+(?:followers\s+)?(?:of\s+|for\s+)?@?([a-z0-9._]+)/,
  ];
  for (const re of patterns) {
    const m = q.match(re);
    if (m && m[1] && !['the', 'a', 'an', 'my'].includes(m[1])) return m[1];
  }
  return null;
}

function extractWeatherLocation(q) {
  const m = q.match(/\b(?:in|at|for)\s+([a-z][a-z\s]+?)(?:\s+(?:today|tomorrow|right now|now))?$/);
  return m ? m[1].trim() : '';
}

function isAiNewsQuery(q) {
  return (
    /\bai\b|artificial intelligence|machine learning|\bllm\b/.test(q) &&
    /\bnews\b|latest|update|headlines|happening|today/.test(q)
  );
}

/**
 * Decide which source a query wants. Specialised shapes win; everything else is
 * a general web query.
 *
 * @param {string} query
 * @returns {{type:'weather'|'market'|'instagram'|'web', [k:string]:any}}
 */
function classifyQuery(query) {
  const q = normalise(query);

  if (/\bweather\b|\bforecast\b|\btemperature\b|how (?:hot|cold)|is it (?:raining|snowing|sunny)/.test(q)) {
    return { type: 'weather', location: extractWeatherLocation(q) };
  }

  const priceContext = /\bprice\b|\bworth\b|\bcost\b|\bvalue\b|trading|\bquote\b|\brate\b|how much/.test(q);
  const symbol = detectMarketSymbol(q);
  if (symbol && priceContext) return { type: 'market', symbol };

  if (/\bfollowers?\b/.test(q) && /\binstagram\b|\binsta\b|\big\b|@/.test(q)) {
    const handle = extractInstagramHandle(q);
    if (handle) return { type: 'instagram', username: handle };
  }

  return { type: 'web' };
}

// --- Orchestration --------------------------------------------------------------

/**
 * Run the general web-query fallback chain: DuckDuckGo → Brave → TechCrunch.
 * A failing layer is swallowed and the next one tried; the shape is always the
 * same so the caller never has to special-case a source.
 */
async function webQuery(query, deps = {}) {
  try {
    const ddg = await scrapeDuckDuckGo(query, deps);
    if (ddg.length) return { source: 'duckduckgo', query, results: ddg };
  } catch {
    /* fall through */
  }

  try {
    const brave = await braveSearch(query, deps);
    if (brave.length) return { source: 'brave', query, results: brave };
  } catch {
    /* fall through */
  }

  if (isAiNewsQuery(normalise(query))) {
    try {
      const news = await techCrunchAiNews(deps);
      if (news.length) return { source: 'techcrunch', query, results: news };
    } catch {
      /* fall through */
    }
  }

  return { source: 'none', query, results: [] };
}

/**
 * Top-level search: route by query shape, then run the right source.
 *
 * @param {string} query
 * @param {object} [deps]  injectable { fetchImpl, braveApiKey }
 * @returns {Promise<object>} a structured result tagged with its `source`
 */
async function search(query, deps = {}) {
  const cls = classifyQuery(query);
  switch (cls.type) {
    case 'weather':
      return { source: 'weather', query, ...(await getWeather(cls.location, deps)) };
    case 'market':
      return { source: 'market', query, ...(await getMarketPrice(cls.symbol, deps)) };
    case 'instagram':
      return { source: 'instagram', query, ...(await getInstagramFollowers(cls.username, deps)) };
    default:
      return webQuery(query, deps);
  }
}

module.exports = {
  DESKTOP_UA,
  // classification
  classifyQuery,
  detectMarketSymbol,
  extractInstagramHandle,
  extractWeatherLocation,
  isAiNewsQuery,
  // parsers (pure)
  parseDuckDuckGo,
  parseRss,
  decodeDdgHref,
  stripTags,
  // sources
  scrapeDuckDuckGo,
  braveSearch,
  techCrunchAiNews,
  getWeather,
  getMarketPrice,
  getInstagramFollowers,
  // orchestration
  webQuery,
  search,
};
