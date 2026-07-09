'use strict';

/**
 * Invoice confirmation flow — the same guardrail as estimates, for invoices.
 *
 * Dan's rule: Jarvis must NEVER send an invoice (and must never take any side
 * action like marking an opportunity won) until it has the template, the
 * customer, the quantity, and the price, has read them back, and Dan has said
 * yes. Deterministic on purpose so the AI can't invent numbers or fire off an
 * invoice — or freelance other CRM changes — on its own.
 *
 * Mirrors quoteFlow: a tiny turn-by-turn state machine. Invoices are due the
 * same day they're sent, so the read-back says "due today".
 */

const {
  isConfirm,
  isCancel,
  money,
  parseTemplate,
  parsePrice,
  parseSquareFeet,
  parseContact,
  nameFromReply,
  bareNumber,
} = require('./quoteFlow');

function isInvoiceStart(text) {
  const t = String(text || '');
  if (!/\binvoices?\b/i.test(t)) return false;
  return (
    /\b(send|create|make|prepare|build|generate|draft|do|put together|shoot|fire|get|give|write|bill|charge)\b/i.test(t) ||
    /\b(?:to|for)\s+[a-z]/i.test(t)
  );
}

function parseInvoiceFields(text) {
  const out = {};
  const c = parseContact(text);
  if (c) out.contactName = c;
  const tpl = parseTemplate(text);
  if (tpl) out.templateName = tpl;
  const price = parsePrice(text); // price per unit (per square foot)
  if (price !== undefined) out.amount = price;
  const qty = parseSquareFeet(text); // quantity (square feet)
  if (qty !== undefined) out.quantity = qty;
  return out;
}

const FIELDS = ['contactName', 'templateName', 'quantity', 'amount'];
function firstMissing(s) {
  return FIELDS.find((f) => s[f] === undefined || s[f] === '') || null;
}
function questionFor(field) {
  switch (field) {
    case 'contactName':
      return 'Who is the invoice for, sir?';
    case 'templateName':
      return 'Which template, sir — flake, metallic, epoxy, grind and seal, stained, or polished?';
    case 'quantity':
      return 'What is the quantity, sir — how many square feet?';
    case 'amount':
      return 'And the price per square foot, sir?';
    default:
      return 'What else, sir?';
  }
}

function readback(s) {
  const total = Number(s.quantity) * Number(s.amount);
  return (
    `To confirm, sir: a ${s.templateName} invoice for ${s.contactName}, ${s.quantity} square feet at ` +
    `$${money(s.amount)} per square foot — that comes to $${money(total)}, due today. Shall I send it?`
  );
}

/**
 * Drive the invoice flow one turn. Same contract as advanceQuote:
 * @returns {{state: object|null, speech?: string, send?: object}}
 */
function advanceInvoice(prev, text) {
  const s = { ...(prev || {}) };
  const parsed = parseInvoiceFields(text);
  const hasNew = Object.keys(parsed).length > 0;

  if (isCancel(text) && !isConfirm(text) && !hasNew) {
    return { state: null, speech: "No problem, sir — I won't send it." };
  }

  if (s.confirming && isConfirm(text) && !hasNew) {
    const { confirming, awaiting, ...fields } = s;
    return { state: null, send: fields };
  }

  Object.assign(s, parsed);
  if (s.awaiting === 'contactName' && !s.contactName && !hasNew) {
    const nm = nameFromReply(text);
    if (nm) s.contactName = nm;
  }
  if (s.awaiting === 'quantity' && parsed.quantity === undefined) {
    const n = bareNumber(text);
    if (n !== undefined) s.quantity = n;
  }
  if (s.awaiting === 'amount' && parsed.amount === undefined) {
    const n = bareNumber(text);
    if (n !== undefined) s.amount = n;
  }

  const miss = firstMissing(s);
  if (miss) {
    s.confirming = false;
    s.awaiting = miss;
    return { state: s, speech: questionFor(miss) };
  }
  s.confirming = true;
  s.awaiting = null;
  return { state: s, speech: readback(s) };
}

module.exports = { isInvoiceStart, advanceInvoice, parseInvoiceFields };
