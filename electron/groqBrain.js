'use strict';

/**
 * The brain (guide Section 3): conversational replies via Groq, with automatic
 * failover across multiple API keys so a rate limit on one key never stops the
 * assistant mid-conversation.
 *
 * Keys are tried in order; a 429 (rate limit), 401 (bad/expired key), or 5xx
 * rotates to the next key and retries. Only when every key fails does reply()
 * throw. The default model is llama3-70b-8192, matching the guide.
 *
 * A personality system prompt runs silently before every turn, and any
 * remembered facts / live-search context are injected after it, so the brain
 * uses what the assistant knows without the user seeing the plumbing.
 *
 * fetch is injectable, so the failover logic is unit-tested without the network.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// The guide's llama3-70b-8192 was decommissioned by Groq; this is a current,
// high-quality replacement. Override with GROQ_MODEL if needed.
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_PERSONALITY =
  'You are Jarvis, a desktop AI voice assistant. You are concise, capable, and ' +
  'a little dry. The user is speaking and hearing your replies, so answer for ' +
  'the ear: short, plain sentences, no markdown, no lists, no emoji. Lead with ' +
  'the answer.';

const MAX_HISTORY = 20; // keep the last N turns to bound the prompt

/**
 * Collect Groq keys from the environment, in priority order, de-duplicated.
 * Accepts GROQ_API_KEY plus GROQ_API_KEY_2../4, or a comma-separated
 * GROQ_API_KEYS. Up to four, per the guide.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string[]}
 */
function loadGroqKeys(env = process.env) {
  const raw = [
    env.GROQ_API_KEY,
    env.GROQ_API_KEY_2,
    env.GROQ_API_KEY_3,
    env.GROQ_API_KEY_4,
    ...String(env.GROQ_API_KEYS || '').split(','),
  ];
  const seen = new Set();
  const keys = [];
  for (const k of raw) {
    const key = String(k || '').trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys.slice(0, 4);
}

class GroqBrain {
  /**
   * @param {object} opts
   * @param {string[]} opts.keys
   * @param {string} [opts.model]
   * @param {string} [opts.personality]
   * @param {() => string} [opts.factsProvider]  returns a memory-context block
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor({ keys = [], model = DEFAULT_MODEL, personality = DEFAULT_PERSONALITY, factsProvider = null, fetchImpl = fetch } = {}) {
    this.keys = keys;
    this.model = model;
    this.personality = personality;
    this.factsProvider = factsProvider;
    this.fetchImpl = fetchImpl;
    this.history = [];
  }

  isConfigured() {
    return this.keys.length > 0;
  }

  /** Build the system prompt: personality + remembered facts + live context. */
  buildSystem(context) {
    const parts = [this.personality];
    const facts = this.factsProvider ? this.factsProvider() : '';
    if (facts) parts.push(facts);
    if (context) parts.push(`Use this current information to answer:\n${context}`);
    return parts.join('\n\n');
  }

  /**
   * Generate a reply. Tries each key in turn on rate-limit / auth / server
   * errors. Maintains conversation history across calls.
   *
   * @param {string} userText
   * @param {{context?: string}} [opts]
   * @returns {Promise<string>}
   */
  async reply(userText, { context = '' } = {}) {
    if (!this.isConfigured()) {
      throw new Error('No Groq API key configured.');
    }

    const messages = [
      { role: 'system', content: this.buildSystem(context) },
      ...this.history,
      { role: 'user', content: userText },
    ];

    let lastError = null;
    for (let i = 0; i < this.keys.length; i++) {
      const key = this.keys[i];
      try {
        const res = await this.fetchImpl(GROQ_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, messages, temperature: 0.7, max_tokens: 300 }),
        });

        // Rotate on rate limit, bad key, or server error.
        if (res.status === 429 || res.status === 401 || res.status >= 500) {
          lastError = new Error(`Groq key ${i + 1} failed: HTTP ${res.status}`);
          continue;
        }
        if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);

        const data = await res.json();
        const reply = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();

        // Commit to history (bounded) only on a real answer.
        this.history.push({ role: 'user', content: userText });
        this.history.push({ role: 'assistant', content: reply });
        if (this.history.length > MAX_HISTORY * 2) {
          this.history = this.history.slice(-MAX_HISTORY * 2);
        }
        return reply;
      } catch (err) {
        lastError = err;
        // network error → try the next key too
      }
    }
    throw new Error(`All Groq keys failed. Last error: ${lastError ? lastError.message : 'unknown'}`);
  }

  reset() {
    this.history = [];
  }
}

module.exports = { GroqBrain, loadGroqKeys, DEFAULT_MODEL, DEFAULT_PERSONALITY };
