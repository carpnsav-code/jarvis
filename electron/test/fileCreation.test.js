'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseCreateCommand, createFile, slugify } = require('../fileCreation');
const { buildPdf, wrapText } = require('../documentBuilder');

test('parseCreateCommand recognises pdf, doc, and note', () => {
  assert.deepEqual(parseCreateCommand('create a pdf about the solar system'), { kind: 'pdf', topic: 'the solar system' });
  assert.deepEqual(parseCreateCommand('make a document about my trip'), { kind: 'doc', topic: 'my trip' });
  assert.deepEqual(parseCreateCommand('write a note to buy milk'), { kind: 'note', topic: 'buy milk' });
  assert.equal(parseCreateCommand('what time is it'), null);
});

test('slugify makes a safe filename stem', () => {
  assert.equal(slugify('The Solar System!'), 'the-solar-system');
  assert.equal(slugify(''), 'document');
});

test('buildPdf produces a structurally valid PDF containing the text', () => {
  const pdf = buildPdf('My Title', 'Hello world. This is the body of the document.');
  const s = pdf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.ok(s.includes('/Type /Catalog'));
  assert.ok(s.includes('(My Title) Tj'));
  assert.ok(s.includes('xref'));
});

test('buildPdf paginates long bodies into multiple page objects', () => {
  const body = Array.from({ length: 200 }, (_, i) => `Line number ${i} with some words to wrap.`).join('\n');
  const s = buildPdf('Big', body).toString('latin1');
  const pageCount = (s.match(/\/Type \/Page\b(?!s)/g) || []).length;
  assert.ok(pageCount > 1, `expected multiple pages, got ${pageCount}`);
});

test('wrapText breaks on width and preserves paragraphs', () => {
  const lines = wrapText('a '.repeat(100).trim(), 20);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => l.length <= 20));
});

test('createFile writes a pdf to the target dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-file-'));
  const r = createFile({ kind: 'pdf', title: 'Solar System', body: 'The sun is a star.' }, { dir, now: new Date('2026-07-08') });
  assert.ok(r.path.endsWith('solar-system-2026-07-08.pdf'));
  assert.ok(fs.existsSync(r.path));
  assert.ok(fs.readFileSync(r.path).toString('latin1').startsWith('%PDF'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createFile writes a note as text with a heading', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-file-'));
  const r = createFile({ kind: 'note', title: 'Groceries', body: 'milk, eggs' }, { dir, now: new Date('2026-07-08') });
  assert.ok(r.path.endsWith('.txt'));
  const text = fs.readFileSync(r.path, 'utf8');
  assert.ok(text.startsWith('Groceries\n'));
  assert.ok(text.includes('milk, eggs'));
  fs.rmSync(dir, { recursive: true, force: true });
});
