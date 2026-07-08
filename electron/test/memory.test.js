'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MemoryStore } = require('../memoryStore');
const { parseFacts, extractFacts, extractInBackground } = require('../memoryExtractor');

// A logger that records lines instead of writing files/console.
function recorder() {
  const lines = [];
  return {
    lines,
    info: (m) => lines.push(['info', m]),
    warn: (m) => lines.push(['warn', m]),
    error: (m) => lines.push(['error', m]),
  };
}

function tempStore(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mem-'));
  const file = path.join(dir, 'memory.json');
  const backup = path.join(dir, 'memory.backup.json');
  return { dir, file, backup, store: new MemoryStore({ file, backup, logger: recorder(), ...extra }) };
}

test('flush writes atomically and leaves no tmp file', () => {
  const { dir, file, store } = tempStore();
  store.addFacts(['likes jazz']);
  store.flush();
  assert.ok(fs.existsSync(file));
  assert.equal(fs.existsSync(file + '.tmp'), false);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.facts[0].text, 'likes jazz');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backup holds the previous good version, refreshed before each write', () => {
  const { dir, file, backup, store } = tempStore();
  store.addFacts(['fact one']);
  store.flush(); // main = [one]; no backup yet (nothing to back up on first write)

  store.addFacts(['fact two']);
  store.flush(); // backup <- [one] (previous), main = [one, two]

  const main = JSON.parse(fs.readFileSync(file, 'utf8'));
  const back = JSON.parse(fs.readFileSync(backup, 'utf8'));
  assert.deepEqual(main.facts.map((f) => f.text), ['fact one', 'fact two']);
  assert.deepEqual(back.facts.map((f) => f.text), ['fact one']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('load falls back to the backup when the main file is corrupt', () => {
  const { dir, file, backup } = tempStore();
  fs.writeFileSync(backup, JSON.stringify({ version: 1, history: [], facts: [{ text: 'from backup', ts: 1 }] }));
  fs.writeFileSync(file, '{ this is not valid json');

  const store = new MemoryStore({ file, backup, logger: recorder() });
  assert.deepEqual(store.getFacts(), ['from backup']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('addFacts de-duplicates case-insensitively', () => {
  const { dir, store } = tempStore();
  assert.equal(store.addFacts(['Likes Jazz', 'plays guitar']), 2);
  assert.equal(store.addFacts(['likes jazz', 'new fact']), 1);
  assert.deepEqual(store.getFacts(), ['Likes Jazz', 'plays guitar', 'new fact']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('factsContext formats facts for prompt injection', () => {
  const { dir, store } = tempStore();
  assert.equal(store.factsContext(), '');
  store.addFacts(['based in Berlin', 'vegetarian']);
  assert.equal(store.factsContext(), 'What you remember about the user:\n- based in Berlin\n- vegetarian');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseFacts accepts a JSON array or a bulleted list', () => {
  assert.deepEqual(parseFacts('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseFacts('- first\n- second'), ['first', 'second']);
  assert.deepEqual(parseFacts('[]'), []);
  assert.deepEqual(parseFacts(''), []);
});

test('extractFacts sends known facts and parses the reply', async () => {
  const record = [];
  const facts = await extractFacts('I just moved to Berlin', 'Nice!', {
    apiKey: 'k',
    knownFacts: ['likes jazz'],
    groqImpl: async (url, opts) => {
      record.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: '["moved to Berlin"]' } }] }) };
    },
  });
  assert.deepEqual(facts, ['moved to Berlin']);
  assert.ok(record[0].messages[1].content.includes('likes jazz')); // known facts injected
});

test('extractInBackground adds facts and logs success', async () => {
  const { dir, store } = tempStore();
  const log = recorder();
  await extractInBackground(store, 'u', 'a', {
    apiKey: 'k',
    logger: log,
    groqImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '["remembers this"]' } }] }) }),
  });
  assert.deepEqual(store.getFacts(), ['remembers this']);
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'info' && /extracted 1 new fact/.test(m)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractInBackground logs errors to the mission log (never throws)', async () => {
  const { dir, store } = tempStore();
  const log = recorder();
  await extractInBackground(store, 'u', 'a', {
    apiKey: 'k',
    logger: log,
    groqImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.deepEqual(store.getFacts(), []);
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'error' && /fact extraction failed/.test(m)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractInBackground skips (and logs) when no Groq key is set', async () => {
  const { dir, store } = tempStore();
  const log = recorder();
  await extractInBackground(store, 'u', 'a', { apiKey: '', logger: log });
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'info' && /skipping fact extraction/.test(m)));
  fs.rmSync(dir, { recursive: true, force: true });
});
