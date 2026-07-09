'use strict';

/**
 * The GHL agent loop: turns a spoken CRM request into real GoHighLevel actions.
 *
 * It's a small tool-calling loop against Groq — the model is given the GHL tools
 * (ghlClient.TOOLS), decides which to call and with what arguments, we execute
 * them live against the API, feed the results back, and repeat until the model
 * produces a spoken answer. This handles multi-step requests naturally (e.g.
 * "text Sam" → look up Sam's contact id → send the message).
 *
 * fetch/Groq are injectable so the loop is testable without a token or network.
 */

const { GHLClient, TOOLS } = require('./ghlClient');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Gemini's OpenAI-compatible endpoint (supports function calling) — a second,
// independent free quota the agent rolls to when Groq is rate-limited.
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
// Tool use benefits from the larger model; the fallback keeps working when the
// big model is rate-limited (free-tier limits on 70b are tight).
const AGENT_MODEL = 'llama-3.3-70b-versatile';
const FALLBACK_MODEL = 'llama-3.1-8b-instant';
const MAX_STEPS = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Send only the tool groups the request needs — the full 13-tool schema costs
// thousands of tokens per step, which matters on free-tier rate limits.
// Contacts are always included (most flows need a contactId).
const TOOL_GROUPS = {
  contacts: ['ghl_latest_leads', 'ghl_list_contacts', 'ghl_create_contact', 'ghl_add_contact_tags'],
  deals: ['ghl_list_pipelines', 'ghl_list_opportunities', 'ghl_update_opportunity'],
  calendar: ['ghl_list_calendars', 'ghl_list_appointments', 'ghl_get_free_slots', 'ghl_create_appointment'],
  convo: ['ghl_list_conversations', 'ghl_send_message'],
  quotes: ['ghl_send_quote', 'ghl_list_estimate_templates'],
};
function toolsFor(text) {
  const t = String(text || '').toLowerCase();
  const names = new Set(TOOL_GROUPS.contacts);
  let matched = false;
  if (/\bdeals?\b|opportunit|pipeline|\bwon\b|\blost\b|stage/.test(t)) {
    TOOL_GROUPS.deals.forEach((n) => names.add(n));
    matched = true;
  }
  if (/calendar|appointment|book|slot|schedul|meet|visit/.test(t)) {
    TOOL_GROUPS.calendar.forEach((n) => names.add(n));
    matched = true;
  }
  if (/\btext\b|\bsms\b|message|email|conversation|\bsay\b|\btell\b|reach out|follow up/.test(t)) {
    TOOL_GROUPS.convo.forEach((n) => names.add(n));
    matched = true;
  }
  if (/quote|estimate|proposal|template/.test(t)) {
    TOOL_GROUPS.quotes.forEach((n) => names.add(n));
    matched = true;
  }
  if (/\bleads?\b|contact|customer|\btag\b/.test(t)) matched = true;
  if (!matched) return TOOLS; // unrecognised request — give it everything
  return TOOLS.filter((tool) => names.has(tool.function.name));
}

// --- Deterministic text-send fast path -------------------------------------------
// "text harold saying we're on for friday" is too important to leave to the
// model (rate limits / weak fallback models break multi-step tool chains), so
// the common phrasings are parsed directly and executed with plain API calls.
const TEXT_PATTERNS = [
  // "send a text to harold saying hey" / "send a message to harold telling him …"
  /\bsend\s+(?:a\s+)?(?:text|sms|message)\s+to\s+([a-z][a-z .'-]{0,40}?)\s+(?:saying|that says|telling (?:him|her|them)\s*(?:that)?|and (?:tell|say)\s*(?:him|her|them)?\s*(?:that)?|that)\s+(.+)/i,
  // "text harold saying hey" / "text harold and tell him …" / "text harold that …"
  /\btext\s+([a-z][a-z .'-]{0,40}?)\s+(?:saying|that says|telling (?:him|her|them)\s*(?:that)?|and (?:tell|say)\s*(?:him|her|them)?\s*(?:that)?|that)\s+(.+)/i,
  // "send harold a text saying hey"
  /\bsend\s+([a-z][a-z .'-]{0,40}?)\s+a\s+(?:text|sms|message)\s+(?:saying|that says)?\s*(.+)/i,
  // typed: "text harold: hey"
  /\btext\s+([a-z][a-z .'-]{0,40}?):\s*(.+)/i,
];

/** @returns {{name:string,message:string}|null} */
function parseTextCommand(text) {
  const t = String(text || '').trim();
  for (const re of TEXT_PATTERNS) {
    const m = t.match(re);
    if (m && m[1].trim() && m[2].trim()) {
      return { name: m[1].trim(), message: m[2].trim() };
    }
  }
  return null;
}

/**
 * Look the contact up by name and send the SMS — deterministically. The match
 * must contain every word of the requested name, or nothing is sent.
 * @returns {Promise<string>} spoken confirmation or a spoken failure reason
 */
async function runTextCommand(client, { name, message }) {
  if (!client || !client.isConfigured()) {
    return 'Your GoHighLevel account is not connected yet, sir.';
  }
  let contacts = [];
  try {
    const d = await client.listContacts({ query: name, limit: 10 });
    contacts = d.contacts || [];
  } catch (err) {
    return `I couldn't search contacts, sir — ${String(err.message).slice(0, 90)}`;
  }
  const norm = (s) => String(s || '').toLowerCase();
  const tokens = norm(name).split(/\s+/).filter(Boolean);
  const displayName = (c) => c.contactName || `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email || 'contact';
  const match = contacts.find((c) => tokens.every((tk) => norm(displayName(c)).includes(tk)));
  if (!match) {
    return `I couldn't find a contact matching "${name}", sir — no text sent.`;
  }
  try {
    await client.sendMessage({ contactId: match.id, type: 'SMS', message });
    return `Text sent to ${displayName(match)}, sir: "${message}"`;
  } catch (err) {
    return `GoHighLevel rejected the text to ${displayName(match)}, sir — ${String(err.message).slice(0, 100)}`;
  }
}

// Deterministic EMAIL path, mirroring the text one ("email harold saying …").
const EMAIL_PATTERNS = [
  /\bsend\s+(?:an?\s+)?e-?mail\s+to\s+([a-z][a-z .'-]{0,40}?)\s+(?:saying|that says|telling (?:him|her|them)\s*(?:that)?|and (?:tell|say)\s*(?:him|her|them)?\s*(?:that)?|that)\s+(.+)/i,
  /\be-?mail\s+([a-z][a-z .'-]{0,40}?)\s+(?:saying|that says|telling (?:him|her|them)\s*(?:that)?|and (?:tell|say)\s*(?:him|her|them)?\s*(?:that)?|that)\s+(.+)/i,
  /\bsend\s+([a-z][a-z .'-]{0,40}?)\s+an?\s+e-?mail\s+(?:saying|that says)?\s*(.+)/i,
];
function parseEmailCommand(text) {
  const t = String(text || '').trim();
  for (const re of EMAIL_PATTERNS) {
    const m = t.match(re);
    if (m && m[1].trim() && m[2].trim()) return { name: m[1].trim(), message: m[2].trim() };
  }
  return null;
}
async function runEmailCommand(client, { name, message }) {
  if (!client || !client.isConfigured()) return 'Your GoHighLevel account is not connected yet, sir.';
  let contacts = [];
  try {
    const d = await client.listContacts({ query: name, limit: 10 });
    contacts = d.contacts || [];
  } catch (err) {
    return `I couldn't search contacts, sir — ${String(err.message).slice(0, 90)}`;
  }
  const norm = (s) => String(s || '').toLowerCase();
  const tokens = norm(name).split(/\s+/).filter(Boolean);
  const displayName = (c) => c.contactName || `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email || 'contact';
  const match = contacts.find((c) => tokens.every((tk) => norm(displayName(c)).includes(tk)));
  if (!match) return `I couldn't find a contact matching "${name}", sir — no email sent.`;
  if (!match.email) return `${displayName(match)} has no email address on file, sir — no email sent.`;
  try {
    await client.sendMessage({
      contactId: match.id,
      type: 'Email',
      message,
      subject: 'Mint Concrete Polishing & Epoxy',
    });
    return `Email sent to ${displayName(match)}, sir: "${message}"`;
  } catch (err) {
    return `GoHighLevel rejected the email to ${displayName(match)}, sir — ${String(err.message).slice(0, 100)}`;
  }
}

// Does this utterance look like a CRM/GHL request?
const GHL_INTENT =
  /\b(ghl|gohighlevel|high level|crm|contacts?|leads?|deals?|opportunit|pipeline|appointments?|my calendar|quotes?|estimates?|invoices?|templates?)\b|\btext\s+\w+|\be-?mail\s+\w+|\bsend (a |an )?(text|sms|message|email|quote|estimate)\b/i;

function isGhlQuery(text) {
  return GHL_INTENT.test(String(text || ''));
}

// Models that hit a rate limit are benched (per model+key) so requests flow
// straight to a model/key that still has quota instead of burning time on
// doomed retries. A daily-cap 429 benches for 10 minutes; a per-minute 429
// benches briefly.
const modelBench = new Map(); // `${model}|${key}` -> epoch ms until usable
function _resetModelBench() {
  modelBench.clear();
}
function benchMs(errText) {
  return /per day|TPD/i.test(errText) ? 10 * 60 * 1000 : 15 * 1000;
}

async function callGroq(messages, { keys, model, groqImpl, tools = TOOLS, geminiKey = process.env.GEMINI_API_KEY }) {
  let lastErr = null;
  // Ladder: Groq primary → Groq fallback → Gemini (independent quota) → all
  // again after a breather so per-minute limits can clear.
  const gem = geminiKey ? [{ url: GEMINI_URL, model: GEMINI_MODEL(), keys: [geminiKey] }] : [];
  const attempts = [
    { url: GROQ_URL, model, keys, wait: 0 },
    { url: GROQ_URL, model: FALLBACK_MODEL, keys, wait: 0 },
    ...gem.map((g) => ({ ...g, wait: 0 })),
    { url: GROQ_URL, model, keys, wait: 1500 },
    { url: GROQ_URL, model: FALLBACK_MODEL, keys, wait: 1200 },
    ...gem.map((g) => ({ ...g, wait: 1000 })),
  ];
  for (const attempt of attempts) {
    const usable = attempt.keys.filter((k) => (modelBench.get(`${attempt.model}|${k}`) || 0) < Date.now());
    if (!usable.length) continue;
    if (attempt.wait) await sleep(attempt.wait);
    for (const key of usable) {
      try {
        const res = await groqImpl(attempt.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: attempt.model, messages, tools, tool_choice: 'auto', temperature: 0.2, max_tokens: 350 }),
        });
        if (res.status === 429 || res.status === 401 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}`);
          if (res.status === 429) {
            let errTxt = '';
            try {
              errTxt = await res.text();
            } catch {
              /* stub responses may lack text() */
            }
            modelBench.set(`${attempt.model}|${key}`, Date.now() + benchMs(errTxt));
          }
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()).choices[0].message;
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw new Error(`Groq failed: ${lastErr ? lastErr.message : 'unknown'}`);
}

/**
 * Run the agent. Returns a spoken answer string.
 *
 * @param {string} text  the user's request
 * @param {object} deps
 * @param {string[]} deps.keys        Groq keys
 * @param {GHLClient} deps.client     configured GHL client
 * @param {typeof fetch} [deps.groqImpl]
 * @param {string} [deps.model]
 * @param {string} [deps.now]         ISO timestamp for date reasoning
 * @returns {Promise<string>}
 */
async function runGhlAgent(text, { keys, client, groqImpl = fetch, model = AGENT_MODEL, geminiKey = process.env.GEMINI_API_KEY, now = new Date().toISOString() }) {
  if ((!keys || !keys.length) && !geminiKey) return 'I need an AI key to run that, sir.';
  keys = keys || [];
  if (!client || !client.isConfigured()) {
    return 'Your GoHighLevel account is not connected yet, sir. Add your GHL token to get me operating it.';
  }

  const messages = [
    {
      role: 'system',
      content:
        'You are JARVIS operating Dan\'s GoHighLevel CRM (Mint Concrete Polishing & ' +
        'Epoxy, Arizona — timezone America/Phoenix) through the provided tools. ' +
        'Call tools to fetch or change real data — never invent contacts, deals, or numbers. ' +
        'A "lead" means a contact. For latest/newest/last lead questions ALWAYS use ' +
        'ghl_latest_leads (sorted newest first) — ghl_list_contacts is NOT date-sorted. ' +
        'To message a contact, first look them up with ghl_list_contacts to get the id. ' +
        'OPERATING RULES: The pipeline is "Mint Concrete Polishing". Never create or ' +
        'reschedule an appointment unless Dan (or the customer, relayed by Dan) has ' +
        'named a specific day AND time. The quote calendar (OxMnzcf1JnHz2LG138Fg) is ' +
        'weekdays only, top-of-the-hour slots, mornings preferred — check free slots ' +
        'before promising a time. For "send a quote/estimate" call ghl_send_quote ONCE — ' +
        'it does the whole SOP (template + customer + sqft × price per sqft, sent by ' +
        'text and email) — using exactly the numbers Dan gave, never invented ones. ' +
        'Never quote a price or recommend a coating system ' +
        '(only exception: a 2-car garage under 500 sq ft flake job is $2,000–3,000 and ' +
        'routes to Joseph Ruiz). Messages sent TO customers are texts in Dan\'s style: ' +
        'blunt, confident, one short line, casual, no sign-off. ' +
        `The current time is ${now}. When done, reply for the ear: one or two short spoken ` +
        'sentences, no markdown or lists, and confirm what you did or found.',
    },
    { role: 'user', content: text },
  ];

  const tools = toolsFor(text);
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const msg = await callGroq(messages, { keys, model, groqImpl, tools, geminiKey });
      messages.push(msg);

      const calls = msg.tool_calls || [];
      if (!calls.length) {
        return (msg.content || 'Done, sir.').trim();
      }

      for (const call of calls) {
        let result;
        try {
          const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          result = await client.dispatch(call.function.name, args);
        } catch (err) {
          result = { error: err.message };
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 3000),
        });
      }
    }
    return 'That took more steps than expected, sir — could you narrow it down?';
  } catch (err) {
    // Never let a CRM/AI hiccup surface as a crash — speak it instead.
    return 'The AI service is momentarily rate-limited, sir. Give it ten seconds and ask me again.';
  }
}

module.exports = { isGhlQuery, runGhlAgent, AGENT_MODEL, _resetModelBench, toolsFor, parseTextCommand, runTextCommand, parseEmailCommand, runEmailCommand };
