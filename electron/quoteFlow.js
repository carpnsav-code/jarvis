'use strict';

/**
 * Estimate confirmation flow.
 *
 * Dan's rule: Jarvis must NEVER send an estimate until it has (a) the template,
 * (b) the square footage, and (c) the price per square foot, has read all three
 * back, and Dan has said yes. This is deterministic on purpose — the AI is not
 * allowed to invent numbers or fire off an estimate on its own.
 *
 * The flow is a tiny state machine driven turn-by-turn. `advanceQuote(state,
 * text)` merges whatever the utterance provides, asks for the next missing
 * field, and — once all fields are present — reads them back and waits for a
 * yes. It returns `{ state, speech }` to keep talking, or `{ send: fields }`
 * when Dan has confirmed and the caller should actually send.
 */

// Known coating templates, longest phrases first so the greediest match wins.
const TEMPLATE_KEYWORDS =
  /\b(polyaspartic flake|marble metallic|single colou?r epoxy|solid colou?r epoxy|grind and seal|grind & seal|grind seal|stained concrete|800 grit polished|400 grit polished|200 grit polished|800 grit|400 grit|200 grit|grit polished|polished concrete|flake|metallic|epoxy|stained|polished)\b/i;

function isQuoteStart(text) {
  const t = String(text || '');
  if (!/\b(estimate|quote|proposal)\b/i.test(t)) return false;
  return (
    /\b(send|create|make|prepare|build|generate|draft|do|put together|shoot|fire|get|give|write)\b/i.test(t) ||
    /\b(?:to|for)\s+[a-z]/i.test(t)
  );
}

function isConfirm(text) {
  return /\b(yes|yeah|yep|yup|sure|send it|send that|send the estimate|send the quote|go ahead|confirm(?:ed)?|do it|that'?s (?:right|correct)|correct|looks good|sounds good|perfect|ship it|fire it off|good to go)\b/i.test(
    String(text || '')
  );
}

function isCancel(text) {
  return /\b(no|nope|nah|cancel|stop|don'?t send|do not send|hold on|scratch that|never ?mind|forget it|abort)\b/i.test(
    String(text || '')
  );
}

function bareNumber(text) {
  const m = String(text || '').match(/(?:^|\s)(\d+(?:\.\d+)?)(?=\s|$|\.)/);
  return m ? Number(m[1]) : undefined;
}

function parsePrice(text) {
  const t = String(text || '');
  let m = t.match(/\$\s*(\d+(?:\.\d+)?)/); // $3.50
  if (m) return Number(m[1]);
  // "3.50 per square foot", "8 a foot", "7 per ft", "8 dollars per square foot"
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:dollars?\s*)?(?:per|a|\/)\s*(?:square\s*)?(?:foot|ft)\b/i);
  if (m) return Number(m[1]);
  m = t.match(/(\d+(?:\.\d+)?)\s*dollars?\b/i); // "8 dollars"
  if (m) return Number(m[1]);
  return undefined;
}

function parseSquareFeet(text) {
  // Strip price phrases first so "per square foot" can't be read as an area.
  const t = String(text || '')
    .replace(/\$\s*\d+(?:\.\d+)?/g, ' ')
    .replace(/(\d+(?:\.\d+)?)\s*(?:dollars?\s*)?(?:per|a|\/)\s*(?:square\s*)?(?:foot|ft)\b/gi, ' ')
    .replace(/(\d+(?:\.\d+)?)\s*dollars?\b/gi, ' ');
  const m = t.match(/(\d[\d,]*)\s*(?:square\s*(?:feet|foot)|sq\.?\s*ft|sqft|feet|foot)\b/i);
  return m ? Number(m[1].replace(/,/g, '')) : undefined;
}

function parseTemplate(text) {
  const m = String(text || '').match(TEMPLATE_KEYWORDS);
  return m ? m[0].trim() : undefined;
}

function parseContact(text) {
  const t = String(text || '');
  let m =
    t.match(/\b(?:estimate|quote|proposal)\s+(?:to|for)\s+([a-z][a-z .'-]*[a-z])/i) ||
    t.match(/\bsend\s+([a-z][a-z .'-]*[a-z])\s+an?\s+(?:estimate|quote|proposal)/i) ||
    t.match(/\b(?:to|for)\s+([a-z][a-z .'-]*[a-z])\s*$/i);
  if (!m) return undefined;
  // Trim anything that belongs to the template/number half of the sentence.
  let name = m[1]
    .split(/\b(?:for|at|with|of|and|square|sq|dollars?|per|a|flake|metallic|epoxy|stained|polished|grind|grit|marble|single|solid)\b/i)[0]
    .replace(/[.,]+$/, '')
    .trim();
  return name && /[a-z]/i.test(name) ? name : undefined;
}

function parseQuoteFields(text) {
  const out = {};
  const c = parseContact(text);
  if (c) out.contactName = c;
  const tpl = parseTemplate(text);
  if (tpl) out.templateName = tpl;
  const price = parsePrice(text);
  if (price !== undefined) out.pricePerSquareFoot = price;
  const sqft = parseSquareFeet(text);
  if (sqft !== undefined) out.squareFeet = sqft;
  return out;
}

const FIELDS = ['contactName', 'templateName', 'squareFeet', 'pricePerSquareFoot'];
function firstMissing(s) {
  return FIELDS.find((f) => s[f] === undefined || s[f] === '') || null;
}
function questionFor(field) {
  switch (field) {
    case 'contactName':
      return 'Who is the estimate for, sir?';
    case 'templateName':
      return 'Which template, sir — flake, metallic, epoxy, grind and seal, stained, or polished?';
    case 'squareFeet':
      return 'How many square feet, sir?';
    case 'pricePerSquareFoot':
      return 'And the price per square foot, sir?';
    default:
      return 'What else, sir?';
  }
}

function money(n) {
  const v = Number(n);
  return v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function readback(s) {
  const total = Number(s.squareFeet) * Number(s.pricePerSquareFoot);
  return (
    `To confirm, sir: a ${s.templateName} estimate for ${s.contactName}, ${s.squareFeet} square feet at ` +
    `$${money(s.pricePerSquareFoot)} per square foot — that comes to $${money(total)}. Shall I send it?`
  );
}

/**
 * Drive the flow one turn.
 * @param {object|null} prev  the pending-estimate state, or null to start fresh
 * @param {string} text       the user's utterance
 * @returns {{state: object|null, speech?: string, send?: object}}
 */
function advanceQuote(prev, text) {
  const s = { ...(prev || {}) };
  const parsed = parseQuoteFields(text);
  const hasNew = Object.keys(parsed).length > 0;

  // Clear, field-free cancel drops the whole thing.
  if (isCancel(text) && !isConfirm(text) && !hasNew) {
    return { state: null, speech: "No problem, sir — I won't send it." };
  }

  // At the confirmation step, a plain yes sends; anything else is treated as a
  // correction and re-confirmed.
  if (s.confirming && isConfirm(text) && !hasNew) {
    const { confirming, awaiting, ...fields } = s;
    return { state: null, send: fields };
  }

  Object.assign(s, parsed);
  // A bare number answers whatever numeric field we just asked for.
  if (s.awaiting === 'squareFeet' && parsed.squareFeet === undefined) {
    const n = bareNumber(text);
    if (n !== undefined) s.squareFeet = n;
  }
  if (s.awaiting === 'pricePerSquareFoot' && parsed.pricePerSquareFoot === undefined) {
    const n = bareNumber(text);
    if (n !== undefined) s.pricePerSquareFoot = n;
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

module.exports = {
  isQuoteStart,
  isConfirm,
  isCancel,
  parseQuoteFields,
  advanceQuote,
  money,
};
