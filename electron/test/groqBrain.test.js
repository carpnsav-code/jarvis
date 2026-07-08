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
  await assert.rejects(() => brain.reply('hi'), /All Groq keys failed/);
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
