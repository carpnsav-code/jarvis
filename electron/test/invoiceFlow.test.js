'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isInvoiceStart, advanceInvoice, parseInvoiceFields } = require('../invoiceFlow');

test('isInvoiceStart recognises invoice requests, ignores estimates/unrelated', () => {
  assert.ok(isInvoiceStart('I want to send an invoice'));
  assert.ok(isInvoiceStart('make an invoice for Sam'));
  assert.ok(isInvoiceStart('bill Danny Carpenter'.replace('bill', 'send an invoice to')));
  assert.equal(isInvoiceStart('send an estimate to Danny'), false);
  assert.equal(isInvoiceStart('what are my open deals'), false);
});

test('parseInvoiceFields pulls out name, template, quantity, amount', () => {
  const f = parseInvoiceFields('send a flake invoice to Sam for 400 square feet at $6 per square foot');
  assert.equal(f.contactName, 'Sam');
  assert.match(f.templateName, /flake/i);
  assert.equal(f.quantity, 400);
  assert.equal(f.amount, 6);
});

test('invoice flow asks for each missing field, never sends early', () => {
  let r = advanceInvoice(null, 'I want to send an invoice');
  assert.ok(!r.send);
  assert.match(r.speech, /who is the invoice for/i);

  r = advanceInvoice(r.state, 'Danny Carpenter');
  assert.ok(!r.send);
  assert.match(r.speech, /which template/i);

  r = advanceInvoice(r.state, 'stained concrete');
  assert.ok(!r.send);
  assert.match(r.speech, /quantity/i);

  r = advanceInvoice(r.state, '500');
  assert.ok(!r.send);
  assert.match(r.speech, /price per square foot/i);

  r = advanceInvoice(r.state, '4');
  assert.ok(!r.send);
  assert.match(r.speech, /to confirm/i);
  assert.match(r.speech, /Danny Carpenter/);
  assert.match(r.speech, /\$2,000/); // 500 * 4
  assert.match(r.speech, /due today/i);
  assert.match(r.speech, /shall i send it/i);
});

test('even a fully specified invoice confirms before sending, then sends on yes', () => {
  let r = advanceInvoice(null, 'send a flake invoice to Sam for 400 square feet at 6 dollars a foot');
  assert.ok(!r.send, 'must not send on the first turn');
  assert.match(r.speech, /to confirm/i);

  r = advanceInvoice(r.state, 'yes send it');
  assert.ok(r.send);
  assert.equal(r.send.contactName, 'Sam');
  assert.match(r.send.templateName, /flake/i);
  assert.equal(r.send.quantity, 400);
  assert.equal(r.send.amount, 6);
});

test('a note is captured, kept out of pricing, and rides to the send', () => {
  let r = advanceInvoice(null, 'send an invoice to Saul Lopez');
  r = advanceInvoice(r.state, 'stained');
  r = advanceInvoice(r.state, 'thousand');
  // Note given at the price step: its "one of three" must NOT be read as a price.
  r = advanceInvoice(r.state, 'leave a note on the invoice that this is payment one of three');
  assert.ok(!r.send);
  assert.match(r.speech, /price per square foot/i, 'note must not satisfy the price question');
  assert.equal(r.state.note, 'this is payment one of three');

  r = advanceInvoice(r.state, 'two dollars a square foot');
  assert.match(r.speech, /to confirm/i);
  assert.match(r.speech, /\$2 per square foot/);
  assert.match(r.speech, /I'll add the note: "this is payment one of three"/);

  // Yes plus a restated note still sends, with the note attached.
  r = advanceInvoice(r.state, 'yes, add the note that this is payment 1 of 3');
  assert.ok(r.send);
  assert.equal(r.send.note, 'this is payment 1 of 3');
  assert.equal(r.send.amount, 2);
});

test('invoice cancel drops the pending invoice', () => {
  const confirming = advanceInvoice(null, 'send a flake invoice to Sam for 400 square feet at 6 dollars a foot');
  const r = advanceInvoice(confirming.state, 'no, cancel that');
  assert.ok(!r.send);
  assert.equal(r.state, null);
});
