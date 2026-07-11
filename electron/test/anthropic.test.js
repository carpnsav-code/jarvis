'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { anthropicMessage, textFrom, toolUsesFrom, toAnthropicTools } = require('../anthropic');

test('anthropicMessage speaks the native wire format for claude-fable-5', async () => {
  const calls = [];
  const resp = await anthropicMessage({
    system: 'You are JARVIS.',
    messages: [{ role: 'user', content: 'hello' }],
    apiKey: 'AK',
    model: 'claude-fable-5',
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'Hello, sir.' }], stop_reason: 'end_turn' }) };
    },
  });
  assert.equal(textFrom(resp), 'Hello, sir.');
  const { url, opts } = calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(opts.headers['x-api-key'], 'AK');
  assert.equal(opts.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(opts.body);
  assert.equal(body.model, 'claude-fable-5');
  assert.equal(body.system, 'You are JARVIS.');
  // Fable 5 rules: no thinking config, no sampling params, refusal fallback on.
  assert.equal(body.thinking, undefined);
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.fallbacks, [{ model: 'claude-opus-4-8' }]);
  assert.match(opts.headers['anthropic-beta'], /server-side-fallback/);
});

test('anthropicMessage retries once without the fallbacks beta on a 400', async () => {
  const bodies = [];
  const resp = await anthropicMessage({
    system: 's',
    messages: [{ role: 'user', content: 'x' }],
    apiKey: 'AK',
    fetchImpl: async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      if (bodies.length === 1) return { ok: false, status: 400, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };
    },
  });
  assert.equal(textFrom(resp), 'ok');
  assert.ok(bodies[0].fallbacks, 'first attempt carries fallbacks');
  assert.equal(bodies[1].fallbacks, undefined, 'retry drops fallbacks');
});

test('toAnthropicTools converts the OpenAI function schema', () => {
  const tools = toAnthropicTools([
    { type: 'function', function: { name: 'ghl_list_opportunities', description: 'List deals', parameters: { type: 'object', properties: { status: { type: 'string' } } } } },
  ]);
  assert.deepEqual(tools, [
    { name: 'ghl_list_opportunities', description: 'List deals', input_schema: { type: 'object', properties: { status: { type: 'string' } } } },
  ]);
});

test('toolUsesFrom extracts tool_use blocks and ignores text/thinking', () => {
  const uses = toolUsesFrom({
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 't1', name: 'ghl_list_pipelines', input: {} },
    ],
  });
  assert.equal(uses.length, 1);
  assert.equal(uses[0].name, 'ghl_list_pipelines');
});
