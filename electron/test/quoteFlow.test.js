'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isQuoteStart, parseQuoteFields, advanceQuote } = require('../quoteFlow');

test('isQuoteStart recognises estimate requests, ignores unrelated speech', () => {
  assert.ok(isQuoteStart('send an estimate to Danny Carpenter'));
  assert.ok(isQuoteStart('make a quote for Sam'));
  assert.ok(isQuoteStart('I want to send an estimate to Danny'));
  assert.equal(isQuoteStart('what are my open deals'), false);
  assert.equal(isQuoteStart('text Harold saying hi'), false);
});

test('parseQuoteFields pulls out name, template, sqft, and price', () => {
  const f = parseQuoteFields('send a stained concrete estimate to Danny Carpenter for 500 square feet at $3.50 per square foot');
  assert.equal(f.contactName, 'Danny Carpenter');
  assert.match(f.templateName, /stained/i);
  assert.equal(f.squareFeet, 500);
  assert.equal(f.pricePerSquareFoot, 3.5);
});

test('price and square footage do not collide', () => {
  // "8 dollars per square foot" must be the price, not 8 sq ft; 600 is the area.
  const f = parseQuoteFields('600 square feet at 8 dollars per square foot');
  assert.equal(f.squareFeet, 600);
  assert.equal(f.pricePerSquareFoot, 8);
});

test('flow asks for each missing field, never sends early', () => {
  // Start with only a name.
  let r = advanceQuote(null, 'send an estimate to Danny Carpenter');
  assert.ok(!r.send);
  assert.match(r.speech, /which template/i);

  r = advanceQuote(r.state, 'stained concrete');
  assert.ok(!r.send);
  assert.match(r.speech, /how many square feet/i);

  r = advanceQuote(r.state, '500'); // bare number answers the sqft question
  assert.ok(!r.send);
  assert.match(r.speech, /price per square foot/i);

  r = advanceQuote(r.state, '3.50'); // bare number answers the price question
  assert.ok(!r.send);
  // Now everything is known — it must read back and ask, not send.
  assert.match(r.speech, /to confirm/i);
  assert.match(r.speech, /Danny Carpenter/);
  assert.match(r.speech, /500 square feet/);
  assert.match(r.speech, /\$3\.50 per square foot/);
  assert.match(r.speech, /\$1,750/); // 500 * 3.50
  assert.match(r.speech, /shall i send it/i);
});

test('even a fully specified request confirms before sending', () => {
  const r = advanceQuote(null, 'send a flake estimate to Sam for 400 square feet at 7 dollars a foot');
  assert.ok(!r.send, 'must not send on the first turn');
  assert.match(r.speech, /to confirm/i);
  assert.match(r.speech, /shall i send it/i);
});

test('yes at the confirm step sends with the collected fields', () => {
  const confirming = advanceQuote(null, 'send a flake estimate to Sam for 400 square feet at 7 dollars a foot');
  const r = advanceQuote(confirming.state, 'yes send it');
  assert.ok(r.send, 'should signal a send');
  assert.equal(r.send.contactName, 'Sam');
  assert.match(r.send.templateName, /flake/i);
  assert.equal(r.send.squareFeet, 400);
  assert.equal(r.send.pricePerSquareFoot, 7);
  assert.equal(r.state, null); // flow cleared
});

test('a correction at the confirm step updates and re-confirms, does not send', () => {
  const confirming = advanceQuote(null, 'send a flake estimate to Sam for 400 square feet at 7 dollars a foot');
  const r = advanceQuote(confirming.state, 'actually make it 600 square feet');
  assert.ok(!r.send, 'a correction must not send');
  assert.equal(r.state.squareFeet, 600);
  assert.match(r.speech, /to confirm/i);
  assert.match(r.speech, /600 square feet/);
});

test('cancel drops the pending estimate', () => {
  const confirming = advanceQuote(null, 'send a flake estimate to Sam for 400 square feet at 7 dollars a foot');
  const r = advanceQuote(confirming.state, 'no, cancel that');
  assert.ok(!r.send);
  assert.equal(r.state, null);
  assert.match(r.speech, /won't send/i);
});
