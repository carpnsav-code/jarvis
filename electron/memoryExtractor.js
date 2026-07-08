'use strict';

/**
 * Background memory extraction.
 *
 * After each turn we ask Groq to pull any durable facts out of the exchange and
 * add them to the store. This runs strictly fire-and-forget: the caller does
 * NOT await it, so it can never delay the voice response. Any failure is routed
 * to the mission log so a silent extraction error becomes a visible line.
 *
 * The store's existing facts are passed in as "already known" so the model
 * doesn't keep re-suggesting things we remember — a small, real use of memory
 * feeding back into a subsequent AI call.
 */

const defaultLogger = require('./missionLog');

/**
 * Parse the model's reply into an array of fact strings. Accepts a JSON array
 * or a plain bulleted/numbered list.
 *
 * @param {string} content
 * @returns {string[]}
 */
function parseFacts(content) {
  const text = String(content || '').trim();
  if (!text) return [];

  try {
    const arr = JSON.parse(text);
    if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    /* not JSON — fall back to line parsing */
  }

  return text
    .split('\n')
    .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean);
}

/**
 * One Groq call that extracts facts from a user/assistant exchange.
 *
 * @param {string} userText
 * @param {string} assistantText
 * @param {object} deps
 * @param {typeof fetch} [deps.groqImpl]
 * @param {string} deps.apiKey
 * @param {string} [deps.model]
 * @param {string[]} [deps.knownFacts]
 * @returns {Promise<string[]>}
 */
async function extractFacts(userText, assistantText, { groqImpl = fetch, apiKey, model = 'llama-3.1-8b-instant', knownFacts = [] }) {
  const known = knownFacts.length ? knownFacts.map((f) => `- ${f}`).join('\n') : '(none)';
  const res = await groqImpl('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content:
            'Extract durable, memorable facts about the user from this exchange ' +
            '(stable preferences, personal details, ongoing projects, commitments). ' +
            'Ignore transient chit-chat and anything already known. Return a JSON ' +
            'array of short strings, or [] if nothing is memorable.',
        },
        {
          role: 'user',
          content: `Already known:\n${known}\n\nUser: ${userText}\nAssistant: ${assistantText}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
  const data = await res.json();
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  return parseFacts(content);
}

/**
 * Fire-and-forget: extract facts and merge them into the store. Never throws;
 * logs both success and failure to the mission log. Returns the promise only so
 * tests can await it — production callers ignore it.
 *
 * @returns {Promise<void>}
 */
function extractInBackground(store, userText, assistantText, { groqImpl, apiKey = process.env.GROQ_API_KEY, model, logger = defaultLogger } = {}) {
  if (!apiKey) {
    logger.info('memory: GROQ_API_KEY unset — skipping fact extraction');
    return Promise.resolve();
  }
  return Promise.resolve()
    .then(() => extractFacts(userText, assistantText, { groqImpl, apiKey, model, knownFacts: store.getFacts() }))
    .then((facts) => {
      const added = store.addFacts(facts);
      if (added) logger.info(`memory: extracted ${added} new fact(s)`);
    })
    .catch((err) => {
      logger.error(`memory: fact extraction failed — ${err.message}`);
    });
}

module.exports = { parseFacts, extractFacts, extractInBackground };
