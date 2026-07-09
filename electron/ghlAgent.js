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
// Tool use benefits from the larger model; the fallback keeps working when the
// big model is rate-limited (free-tier limits on 70b are tight).
const AGENT_MODEL = 'llama-3.3-70b-versatile';
const FALLBACK_MODEL = 'llama-3.1-8b-instant';
const MAX_STEPS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Does this utterance look like a CRM/GHL request?
const GHL_INTENT =
  /\b(ghl|gohighlevel|high level|crm|contacts?|leads?|deals?|opportunit|pipeline|appointments?|my calendar)\b|\btext\s+\w+|\bsend (a |an )?(text|sms|message|email)\b/i;

function isGhlQuery(text) {
  return GHL_INTENT.test(String(text || ''));
}

async function callGroq(messages, { keys, model, groqImpl }) {
  let lastErr = null;
  // Resilience ladder: primary model ×2 passes (with a breather between, so a
  // per-minute rate limit can clear), then one pass on the fallback model.
  const attempts = [
    { model, wait: 0 },
    { model, wait: 1500 },
    { model: FALLBACK_MODEL, wait: 800 },
  ];
  for (const attempt of attempts) {
    if (attempt.wait) await sleep(attempt.wait);
    for (const key of keys) {
      try {
        const res = await groqImpl(GROQ_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: attempt.model, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.2, max_tokens: 500 }),
        });
        if (res.status === 429 || res.status === 401 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}`);
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
async function runGhlAgent(text, { keys, client, groqImpl = fetch, model = AGENT_MODEL, now = new Date().toISOString() }) {
  if (!keys || !keys.length) return 'I need a Groq key to run that, sir.';
  if (!client || !client.isConfigured()) {
    return 'Your GoHighLevel account is not connected yet, sir. Add your GHL token to get me operating it.';
  }

  const messages = [
    {
      role: 'system',
      content:
        'You are JARVIS operating the user\'s GoHighLevel CRM through the provided tools. ' +
        'Call tools to fetch or change real data — never invent contacts, deals, or numbers. ' +
        'To message a contact, first look them up with ghl_list_contacts to get the id. ' +
        `The current time is ${now}. When done, reply for the ear: one or two short spoken ` +
        'sentences, no markdown or lists, and confirm what you did or found.',
    },
    { role: 'user', content: text },
  ];

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const msg = await callGroq(messages, { keys, model, groqImpl });
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

module.exports = { isGhlQuery, runGhlAgent, AGENT_MODEL };
