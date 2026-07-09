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
// Google Gemini's OpenAI-compatible endpoint — a second, independent free
// quota (~1500 requests/day) the brain rolls over to when Groq is tapped out.
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
// Default to Groq's fastest model for near-instant voice replies. Set
// GROQ_MODEL=llama-3.3-70b-versatile if you want higher quality over speed.
const DEFAULT_MODEL = 'llama-3.1-8b-instant';
const DEFAULT_PERSONALITY =
  'You are JARVIS, a highly capable AI assistant in the spirit of Tony Stark\'s ' +
  'assistant: a composed, quick-witted British AI. You are efficient, unflappable, ' +
  'and dryly funny, with impeccable manners — you may occasionally address the user ' +
  'as "sir". The user is speaking to you and hearing your replies, so answer for the ' +
  'ear: short, plain spoken sentences, no markdown, no lists, no emoji. Lead with the ' +
  'answer, keep it tight, and never ramble. Never say the word "Jarvis" in your replies.';

const MAX_HISTORY = 8; // keep the last N turns to bound the prompt (voice turns are short)

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
  constructor({ keys = [], model = DEFAULT_MODEL, personality = DEFAULT_PERSONALITY, factsProvider = null, knowledge = '', geminiKey = process.env.GEMINI_API_KEY, geminiModel = process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL, fetchImpl = fetch } = {}) {
    this.keys = keys;
    this.geminiKey = geminiKey || '';
    this.geminiModel = geminiModel;
    this.model = model;
    this.personality = personality;
    this.factsProvider = factsProvider;
    this.knowledge = knowledge; // "training" injected every turn
    this.fetchImpl = fetchImpl;
    this.history = [];
  }

  isConfigured() {
    return this.keys.length > 0 || Boolean(this.geminiKey);
  }

  /** All AI endpoints in priority order: every Groq key, then Gemini. */
  endpoints() {
    const eps = this.keys.map((key, i) => ({ url: GROQ_URL, key, model: this.model, label: `groq key ${i + 1}` }));
    if (this.geminiKey) eps.push({ url: GEMINI_URL, key: this.geminiKey, model: this.geminiModel, label: 'gemini' });
    return eps;
  }

  /** Build the system prompt: personality + knowledge + remembered facts + live context.
   *  `knowledge` overrides the constructor default per turn — pass '' to skip it
   *  entirely (keeps casual turns cheap on rate-limited keys). */
  buildSystem(context, knowledge) {
    const kb = knowledge === undefined ? this.knowledge : knowledge;
    const parts = [this.personality];
    if (kb) parts.push(`Background knowledge you have:\n${kb}`);
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
  async reply(userText, { context = '', knowledge } = {}) {
    if (!this.isConfigured()) {
      throw new Error('No Groq API key configured.');
    }

    const messages = [
      { role: 'system', content: this.buildSystem(context, knowledge) },
      ...this.history,
      { role: 'user', content: userText },
    ];

    let lastError = null;
    // Two passes over the keys with a breather between, so a single-key
    // per-minute rate limit recovers instead of failing the turn.
    for (let pass = 0; pass < 2; pass++) {
      if (pass > 0) await new Promise((r) => setTimeout(r, 1300));
      const reply = await this.tryKeys(messages, userText);
      if (reply !== null) return reply;
      lastError = this.lastTryError;
    }
    throw new Error(`All AI providers failed. Last error: ${lastError ? lastError.message : 'unknown'}`);
  }

  /** One rotation over every endpoint (Groq keys, then Gemini); null if all failed. */
  async tryKeys(messages, userText) {
    this.lastTryError = null;
    for (const ep of this.endpoints()) {
      try {
        const res = await this.fetchImpl(ep.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${ep.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: ep.model, messages, temperature: 0.7, max_tokens: 300 }),
        });

        // Rotate on rate limit, bad key, or server error.
        if (res.status === 429 || res.status === 401 || res.status >= 500) {
          this.lastTryError = new Error(`${ep.label} failed: HTTP ${res.status}`);
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
        this.lastTryError = err;
        // network error → try the next key too
      }
    }
    return null;
  }

  reset() {
    this.history = [];
  }
}

module.exports = { GroqBrain, loadGroqKeys, DEFAULT_MODEL, DEFAULT_PERSONALITY };
