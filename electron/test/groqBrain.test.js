'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GroqBrain, loadGroqKeys } = require('../groqBrain');

test('loadGroqKeys collects up to four keys, de-duped, in order', () => {
  const keys = loadGroqKeys({ GROQ_API_KEY: 'a', GROQ_API_KEY_2: 'b', GROQ_API_KEYS: 'b,c,d,e' });
  assert.deepEqual(keys, ['a', 'b', 'c', 'd']); // dedupe b, cap at 4
});

test('reply fails over to the next key on a 429', async () => {
  const tried = [];
  const brain = new GroqBrain({
    keys: ['k1', 'k2'],
    fetchImpl: async (url, opts) => {
      const key = opts.headers.Authorization;
      tried.push(key);
      if (key.endsWith('k1')) return { status: 429, ok: false, json: async () => ({}) };
      return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: 'hello there' } }] }) };
    },
  });
  const reply = await brain.reply('hi');
  assert.equal(reply, 'hello there');
  assert.deepEqual(tried, ['Bearer k1', 'Bearer k2']); // rotated
});

test('reply throws only when every key fails', async () => {
  const brain = new GroqBrain({
    keys: ['k1', 'k2'],
    fetchImpl: async () => ({ status: 429, ok: false, json: async () => ({}) }),
  });
  await assert.rejects(() => brain.reply('hi'), /All AI providers failed/);
});

test('reply injects personality, facts, and live context into the system prompt', async () => {
  let sentSystem = '';
  const brain = new GroqBrain({
    keys: ['k1'],
    personality: 'Be terse.',
    factsProvider: () => 'What you remember about the user:\n- likes jazz',
    fetchImpl: async (url, opts) => {
      sentSystem = JSON.parse(opts.body).messages[0].content;
      return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    },
  });
  await brain.reply('who am i', { context: 'It is Tuesday.' });
  assert.ok(sentSystem.includes('Be terse.'));
  assert.ok(sentSystem.includes('likes jazz'));
  assert.ok(sentSystem.includes('It is Tuesday.'));
});

test('reply keeps conversation history across turns', async () => {
  let lastMessages = [];
  const brain = new GroqBrain({
    keys: ['k1'],
    fetchImpl: async (url, opts) => {
      lastMessages = JSON.parse(opts.body).messages;
      return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: 'reply' } }] }) };
    },
  });
  await brain.reply('first');
  await brain.reply('second');
  // system + (user first, assistant reply) + user second
  assert.equal(lastMessages[0].role, 'system');
  assert.equal(lastMessages[1].content, 'first');
  assert.equal(lastMessages[2].content, 'reply');
  assert.equal(lastMessages[3].content, 'second');
});

test('isConfigured reflects whether any key is present', () => {
  assert.equal(new GroqBrain({ keys: [] }).isConfigured(), false);
  assert.equal(new GroqBrain({ keys: ['x'] }).isConfigured(), true);
});

test('reply rolls over to Gemini when every Groq key is rate-limited', async () => {
  const urls = [];
  const brain = new GroqBrain({
    keys: ['k1'],
    geminiKey: 'gem1',
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('groq')) return { status: 429, ok: false, json: async () => ({}) };
      return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: 'from gemini' } }] }) };
    },
  });
  assert.equal(await brain.reply('hi'), 'from gemini');
  assert.ok(urls.some((u) => u.includes('generativelanguage')));
});

test('isConfigured is true with only a Gemini key', () => {
  assert.equal(new GroqBrain({ keys: [], geminiKey: 'g' }).isConfigured(), true);
  assert.equal(new GroqBrain({ keys: [], geminiKey: '' }).isConfigured(), false);
});

test('reply prefers the Fable 5 brain when an Anthropic key is set', async () => {
  const urls = [];
  const brain = new GroqBrain({
    keys: ['k1'],
    anthropicKey: 'AK',
    fetchImpl: async (url, opts) => {
      urls.push(url);
      if (url.includes('api.anthropic.com')) {
        const body = JSON.parse(opts.body);
        // system separate, no thinking config, no temperature — Fable 5 rules
        assert.ok(body.system.length > 0);
        assert.equal(body.thinking, undefined);
        assert.equal(body.temperature, undefined);
        return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'From Claude, sir.' }] }) };
      }
      throw new Error('should not reach groq');
    },
  });
  assert.equal(await brain.reply('hi'), 'From Claude, sir.');
  assert.ok(urls[0].includes('api.anthropic.com'));
});

test('reply falls back to Groq when Anthropic fails', async () => {
  const brain = new GroqBrain({
    keys: ['k1'],
    anthropicKey: 'AK',
    fetchImpl: async (url) => {
      if (url.includes('api.anthropic.com')) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'from groq' } }] }) };
    },
  });
  assert.equal(await brain.reply('hi'), 'from groq');
});

test('isConfigured is true with only an Anthropic key', () => {
  assert.equal(new GroqBrain({ keys: [], geminiKey: '', anthropicKey: 'a' }).isConfigured(), true);
});
