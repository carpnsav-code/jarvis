'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GHLClient, TOOLS } = require('../ghlClient');
const { isGhlQuery, runGhlAgent, _resetModelBench } = require('../ghlAgent');

function stubFetch(handlers, record = []) {
  return async (url, opts) => {
    record.push({ url, opts });
    for (const [needle, fn] of handlers) {
      if (url.includes(needle)) return fn(url, opts);
    }
    throw new Error('unhandled ' + url);
  };
}
const ok = (json) => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });

test('client is configured only with token + location', () => {
  assert.equal(new GHLClient({ token: 't', locationId: 'l' }).isConfigured(), true);
  assert.equal(new GHLClient({ token: 't', locationId: '' }).isConfigured(), false);
  assert.equal(new GHLClient({ token: '', locationId: '' }).isConfigured(), false);
});

test('listOpportunities builds the right query with location + status', async () => {
  const rec = [];
  const c = new GHLClient({ token: 't', locationId: 'LOC', fetchImpl: stubFetch([['/opportunities/search', () => ok({ opportunities: [] })]], rec) });
  await c.listOpportunities({ status: 'open' });
  const u = new URL(rec[0].url);
  assert.equal(u.pathname, '/opportunities/search');
  assert.equal(u.searchParams.get('location_id'), 'LOC');
  assert.equal(u.searchParams.get('status'), 'open');
  assert.equal(rec[0].opts.headers.Version, '2021-07-28');
  assert.match(rec[0].opts.headers.Authorization, /Bearer t/);
});

test('sendMessage posts to conversations with the body', async () => {
  const rec = [];
  const c = new GHLClient({ token: 't', locationId: 'l', fetchImpl: stubFetch([['/conversations/messages', () => ok({ ok: true })]], rec) });
  await c.sendMessage({ contactId: 'c1', type: 'SMS', message: 'hi' });
  assert.equal(rec[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(rec[0].opts.body), { contactId: 'c1', type: 'SMS', message: 'hi' });
});

test('dispatch routes tool names to methods', async () => {
  const c = new GHLClient({ token: 't', locationId: 'l', fetchImpl: stubFetch([['/opportunities/pipelines', () => ok({ pipelines: [{ id: 'p1' }] })]]) });
  const r = await c.dispatch('ghl_list_pipelines', {});
  assert.deepEqual(r, { pipelines: [{ id: 'p1' }] });
});

test('request throws a clear error on non-2xx', async () => {
  const c = new GHLClient({ token: 't', locationId: 'l', fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }) });
  await assert.rejects(() => c.listContacts(), /HTTP 401/);
});

test('isGhlQuery detects CRM intent', () => {
  assert.equal(isGhlQuery('what are my open deals'), true);
  assert.equal(isGhlQuery('text Sam saying I am late'), true);
  assert.equal(isGhlQuery('list my contacts in ghl'), true);
  assert.equal(isGhlQuery('what is the weather'), false);
});

test('runGhlAgent says not connected without a token', async () => {
  const client = new GHLClient({ token: '', locationId: '' });
  _resetModelBench();
  const speech = await runGhlAgent('open deals', { keys: ['k'], client });
  assert.match(speech, /not connected/i);
});

test('runGhlAgent survives a rate limit: 429 first, succeeds on retry', async () => {
  _resetModelBench();
  const client = new GHLClient({ token: 't', locationId: 'l', fetchImpl: async () => ok({}) });
  let calls = 0;
  const groqImpl = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'You have three open deals, sir.' } }] }) };
  };
  const speech = await runGhlAgent('how many deals', { keys: ['k'], client, groqImpl });
  assert.match(speech, /three open deals/);
  assert.ok(calls >= 2, 'should have retried after the 429');
});

test('runGhlAgent never throws — total AI failure becomes a spoken reply', async () => {
  _resetModelBench();
  const client = new GHLClient({ token: 't', locationId: 'l', fetchImpl: async () => ok({}) });
  const groqImpl = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const speech = await runGhlAgent('list my deals', { keys: ['k'], client, groqImpl });
  assert.match(speech, /rate-limited|snag/i);
});

test('runGhlAgent runs a tool-calling loop and returns the spoken answer', async () => {
  _resetModelBench();
  const client = new GHLClient({
    token: 't', locationId: 'l',
    fetchImpl: stubFetch([['/opportunities/search', () => ok({ opportunities: [{ name: 'Acme', monetaryValue: 5000 }] })]]),
  });
  // Groq stub: first return a tool call, then a final answer using the results.
  let turn = 0;
  const groqImpl = async () => {
    turn += 1;
    if (turn === 1) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'x', function: { name: 'ghl_list_opportunities', arguments: '{"status":"open"}' } }] } }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'You have one open deal, Acme, worth five thousand dollars, sir.' } }] }) };
  };
  const speech = await runGhlAgent('what are my open deals', { keys: ['k'], client, groqImpl });
  assert.match(speech, /Acme/);
  assert.equal(turn, 2); // one tool round + one answer
});
