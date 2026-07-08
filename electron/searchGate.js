'use strict';

/**
 * The search gate: a fast, cheap check that runs *before* a web search to decide
 * whether the message actually needs live data. The point is to not fire off a
 * search (and its downstream fetches) for things the assistant can answer on its
 * own.
 *
 * Two short-circuits keep it cheap:
 *   - Trivial messages ("hey", "ok", "thanks") skip the gate entirely — no Groq
 *     call at all, because burning an API round-trip on a greeting is exactly
 *     what we're trying to avoid.
 *   - With no Groq key configured, the gate fails OPEN (assume live data is
 *     wanted) so search still works keyless — the gate is an optimisation, never
 *     a hard dependency.
 *
 * The Groq call itself is a one-word YES/NO classification on a small, fast
 * model, with an injectable fetch for testing.
 */

// Bare acknowledgements / greetings that never need a search.
const TRIVIAL = new Set([
  'hi', 'hey', 'hello', 'heya', 'hiya', 'yo', 'sup', 'howdy',
  'ok', 'okay', 'k', 'kk', 'cool', 'nice', 'great', 'awesome', 'sweet',
  'thanks', 'thank you', 'thx', 'ty', 'cheers', 'no worries',
  'yes', 'yeah', 'yep', 'yup', 'no', 'nope', 'nah', 'sure',
  'lol', 'haha', 'hmm', 'oh', 'ah', 'right', 'gotcha', 'good', 'fine',
  'bye', 'goodbye', 'see ya', 'later', 'good night', 'goodnight',
]);

function normalise(message) {
  return String(message == null ? '' : message)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s&']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is this message too trivial to bother searching for? Greetings, one-word
 * acks, and "good morning"-style openers.
 *
 * @param {string} message
 * @returns {boolean}
 */
function isTrivial(message) {
  const t = normalise(message);
  if (!t) return true;
  if (TRIVIAL.has(t)) return true;
  if (/^(good (morning|afternoon|evening|night))\b/.test(t)) return true;
  if (/^how (are|is it going|s it going)\b/.test(t)) return true;
  // A single very short token ("yo", "eh").
  const words = t.split(' ');
  if (words.length === 1 && t.length <= 4) return true;
  return false;
}

/**
 * Ask Groq (one word, YES/NO) whether answering needs live/current data.
 *
 * @param {string} message
 * @param {object} deps
 * @param {typeof fetch} [deps.groqImpl]
 * @param {string} deps.apiKey
 * @param {string} [deps.model]
 * @returns {Promise<boolean>}
 */
async function groqNeedsLiveData(message, { groqImpl = fetch, apiKey, model = 'llama-3.1-8b-instant' }) {
  const res = await groqImpl('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 3,
      messages: [
        {
          role: 'system',
          content:
            'Decide whether answering the user requires live or current information ' +
            '(news, weather, prices, sports scores, recent events, real-time facts). ' +
            'Answer with exactly one word: YES or NO.',
        },
        { role: 'user', content: message },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
  const data = await res.json();
  const text = ((data.choices && data.choices[0] && data.choices[0].message &&
    data.choices[0].message.content) || '').trim().toLowerCase();
  return text.startsWith('y');
}

/**
 * The gate. Returns whether to run a live search, plus why.
 *
 * @param {string} message
 * @param {object} [deps]
 * @param {typeof fetch} [deps.groqImpl]
 * @param {string} [deps.apiKey=process.env.GROQ_API_KEY]
 * @param {string} [deps.model]
 * @returns {Promise<{live:boolean, gated:boolean, reason:string}>}
 */
async function searchGate(message, { groqImpl, apiKey = process.env.GROQ_API_KEY, model } = {}) {
  if (isTrivial(message)) {
    return { live: false, gated: false, reason: 'trivial message — skipped gate' };
  }
  if (!apiKey) {
    // No key → can't gate; fail open so keyless search still works.
    return { live: true, gated: false, reason: 'no Groq key — proceeding without gate' };
  }
  try {
    const live = await groqNeedsLiveData(message, { groqImpl, apiKey, model });
    return { live, gated: true, reason: live ? 'Groq: live data needed' : 'Groq: no live data needed' };
  } catch (err) {
    // A gate failure must never block search — fail open.
    return { live: true, gated: false, reason: `Groq gate error (${err.message}) — proceeding` };
  }
}

module.exports = { isTrivial, groqNeedsLiveData, searchGate, TRIVIAL };
