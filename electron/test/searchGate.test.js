'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isTrivial, searchGate } = require('../searchGate');

test('isTrivial catches greetings and one-word acks', () => {
  for (const t of ['hey', 'hi', 'ok', 'okay', 'thanks', 'good morning', 'yo', '']) {
    assert.equal(isTrivial(t), true, `"${t}" should be trivial`);
  }
});

test('isTrivial lets real questions through', () => {
  for (const t of ['what is the weather', 'price of bitcoin', 'who won the game last night']) {
    assert.equal(isTrivial(t), false, `"${t}" should not be trivial`);
  }
});

test('gate skips Groq entirely for trivial messages', async () => {
  const res = await searchGate('hey', {
    groqImpl: async () => assert.fail('must not call Groq for a greeting'),
    apiKey: 'test-key',
  });
  assert.equal(res.live, false);
  assert.equal(res.gated, false);
});

test('gate fails open (proceeds) when no Groq key is configured', async () => {
  const res = await searchGate('what is the latest news', { apiKey: '' });
  assert.equal(res.live, true);
  assert.equal(res.gated, false);
});

test('gate asks Groq for non-trivial messages and honours YES/NO', async () => {
  const yes = await searchGate('what is bitcoin trading at', {
    apiKey: 'k',
    groqImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'YES' } }] }) }),
  });
  assert.equal(yes.live, true);
  assert.equal(yes.gated, true);

  const no = await searchGate('tell me a joke', {
    apiKey: 'k',
    groqImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'NO' } }] }) }),
  });
  assert.equal(no.live, false);
  assert.equal(no.gated, true);
});

test('gate fails open if the Groq call errors', async () => {
  const res = await searchGate('what is happening in the news', {
    apiKey: 'k',
    groqImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.equal(res.live, true);
  assert.equal(res.gated, false);
});
