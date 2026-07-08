'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DESKTOP_UA,
  classifyQuery,
  detectMarketSymbol,
  extractInstagramHandle,
  isAiNewsQuery,
  parseDuckDuckGo,
  parseRss,
  decodeDdgHref,
  scrapeDuckDuckGo,
  braveSearch,
  getWeather,
  getMarketPrice,
  getInstagramFollowers,
  webQuery,
  search,
} = require('../webSearch');

// A fetch stub that returns a canned response and records the request.
function stubFetch(response, record = []) {
  return async (url, opts) => {
    record.push({ url, opts });
    return {
      ok: response.ok !== false,
      status: response.status || 200,
      text: async () => response.text || '',
      json: async () => response.json || {},
    };
  };
}

const DDG_HTML = `
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">First <b>Result</b></a>
    <a class="result__snippet" href="//x">A snippet about the <b>first</b> thing.</a>
  </div>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftwo">Second Result</a>
    <a class="result__snippet" href="//y">Second snippet.</a>
  </div>`;

test('the exact required desktop User-Agent is used', () => {
  assert.equal(
    DESKTOP_UA,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  );
});

test('parseDuckDuckGo extracts titles, decoded urls, and snippets', () => {
  const results = parseDuckDuckGo(DDG_HTML);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    title: 'First Result',
    url: 'https://example.com/one',
    snippet: 'A snippet about the first thing.',
  });
  assert.equal(results[1].url, 'https://example.com/two');
});

test('decodeDdgHref unwraps the uddg redirect', () => {
  assert.equal(
    decodeDdgHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Ffoo.test%2Fa%3Fb%3D1'),
    'https://foo.test/a?b=1',
  );
});

test('scrapeDuckDuckGo sends the UA and Cache-Control: no-cache', async () => {
  const record = [];
  const results = await scrapeDuckDuckGo('cats', {
    fetchImpl: stubFetch({ text: DDG_HTML }, record),
  });
  assert.equal(results.length, 2);
  assert.equal(record[0].opts.headers['User-Agent'], DESKTOP_UA);
  assert.equal(record[0].opts.headers['Cache-Control'], 'no-cache');
  assert.ok(record[0].url.startsWith('https://html.duckduckgo.com/html/?q='));
});

test('classifyQuery routes weather, market, instagram, and web', () => {
  assert.deepEqual(classifyQuery('what is the weather in Paris'), {
    type: 'weather',
    location: 'paris',
  });
  assert.deepEqual(classifyQuery('what is the price of bitcoin'), {
    type: 'market',
    symbol: 'BTC-USD',
  });
  assert.deepEqual(classifyQuery('how many followers does @natgeo have on instagram'), {
    type: 'instagram',
    username: 'natgeo',
  });
  assert.deepEqual(classifyQuery('history of the roman empire'), { type: 'web' });
});

test('detectMarketSymbol maps the three supported assets', () => {
  assert.equal(detectMarketSymbol('price of btc'), 'BTC-USD');
  assert.equal(detectMarketSymbol('ethereum worth'), 'ETH-USD');
  assert.equal(detectMarketSymbol('s&p 500 today'), '^GSPC');
  assert.equal(detectMarketSymbol('gold price'), null);
});

test('extractInstagramHandle finds the handle in common phrasings', () => {
  assert.equal(extractInstagramHandle('followers of @cristiano'), 'cristiano');
  assert.equal(extractInstagramHandle('how many followers does natgeo have'), 'natgeo');
});

test('isAiNewsQuery needs both an AI term and a news term', () => {
  assert.equal(isAiNewsQuery('latest ai news'), true);
  assert.equal(isAiNewsQuery('what is a neural network'), false);
});

test('webQuery falls through DuckDuckGo → Brave when DDG is empty', async () => {
  const deps = {
    fetchImpl: async (url) => {
      if (url.includes('duckduckgo')) return { ok: true, text: async () => '<html>no results</html>' };
      if (url.includes('brave')) {
        return {
          ok: true,
          json: async () => ({ web: { results: [{ title: 'B', url: 'u', description: 'd' }] } }),
        };
      }
      throw new Error('unexpected url ' + url);
    },
    braveApiKey: 'test-key',
  };
  const res = await webQuery('something obscure', deps);
  assert.equal(res.source, 'brave');
  assert.equal(res.results[0].title, 'B');
});

test('webQuery falls to TechCrunch for AI-news queries when web layers are empty', async () => {
  const rss = '<rss><channel><item><title>New AI model ships</title><link>https://tc/x</link><description>details</description></item></channel></rss>';
  const deps = {
    fetchImpl: async (url) => {
      if (url.includes('duckduckgo')) return { ok: true, text: async () => 'nothing' };
      if (url.includes('techcrunch')) return { ok: true, text: async () => rss };
      throw new Error('unexpected ' + url);
    },
    // no brave key → layer 2 skipped
  };
  const res = await webQuery('latest ai news today', deps);
  assert.equal(res.source, 'techcrunch');
  assert.equal(res.results[0].title, 'New AI model ships');
});

test('parseRss reads item title/link/description and strips CDATA', () => {
  const items = parseRss('<item><title><![CDATA[Hello]]></title><link>u</link><description><![CDATA[<p>body</p>]]></description></item>');
  assert.equal(items[0].title, 'Hello');
  assert.equal(items[0].snippet, 'body');
});

test('braveSearch is a no-op without a key', async () => {
  const results = await braveSearch('x', { fetchImpl: async () => assert.fail('must not fetch'), braveApiKey: '' });
  assert.deepEqual(results, []);
});

test('getWeather reads current_condition from the j1 JSON', async () => {
  const record = [];
  const res = await getWeather('London', {
    fetchImpl: stubFetch({
      json: {
        current_condition: [{ temp_C: '12', temp_F: '54', FeelsLikeC: '10', humidity: '80', weatherDesc: [{ value: 'Cloudy' }] }],
        nearest_area: [{ areaName: [{ value: 'London' }] }],
      },
    }, record),
  });
  assert.equal(res.description, 'Cloudy');
  assert.equal(res.tempC, 12);
  assert.ok(record[0].url.startsWith('https://wttr.in/London?format=j1'));
});

test('getMarketPrice reads the Yahoo chart meta', async () => {
  const res = await getMarketPrice('BTC-USD', {
    fetchImpl: stubFetch({
      json: { chart: { result: [{ meta: { regularMarketPrice: 65000, currency: 'USD', chartPreviousClose: 64000 } }] } },
    }),
  });
  assert.equal(res.price, 65000);
  assert.equal(res.previousClose, 64000);
});

test('getInstagramFollowers sends the app-id header and reads the count', async () => {
  const record = [];
  const res = await getInstagramFollowers('@natgeo', {
    fetchImpl: stubFetch({
      json: { data: { user: { full_name: 'National Geographic', edge_followed_by: { count: 280000000 } } } },
    }, record),
  });
  assert.equal(res.followers, 280000000);
  assert.equal(res.username, 'natgeo');
  assert.equal(record[0].opts.headers['X-IG-App-ID'], '936619743392459');
  assert.equal(record[0].opts.headers['User-Agent'], DESKTOP_UA);
});

test('search routes a weather query to the weather source', async () => {
  const res = await search('weather in Berlin', {
    fetchImpl: stubFetch({
      json: { current_condition: [{ temp_C: '5', temp_F: '41', FeelsLikeC: '3', humidity: '70', weatherDesc: [{ value: 'Clear' }] }] },
    }),
  });
  assert.equal(res.source, 'weather');
  assert.equal(res.description, 'Clear');
});
