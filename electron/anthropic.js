'use strict';

/**
 * Native Anthropic Messages API caller — the "Fable 5 brain".
 *
 * Raw HTTP via the global fetch on purpose: this app is deliberately
 * zero-dependency (no npm install anywhere), so the official SDK is out and the
 * OpenAI-compatibility shim is explicitly NOT used — this speaks Anthropic's own
 * wire format (system separate from messages, content blocks, tool_use /
 * tool_result, input_schema tools).
 *
 * claude-fable-5 specifics honoured here:
 * - Thinking is always on — the `thinking` param is omitted entirely (an
 *   explicit config is rejected). Depth is controlled with output_config.effort.
 * - No temperature/top_p/top_k (removed — sending them is a 400).
 * - max_tokens covers thinking + answer, so it must be generous even for a
 *   one-sentence spoken reply.
 * - Safety classifiers can decline a benign request (HTTP 200 with
 *   stop_reason "refusal"), so the server-side fallback to claude-opus-4-8 is
 *   on by default — the API re-runs the same request on Opus and still answers.
 *   If the account rejects the beta, we retry once without it.
 *
 * fetch is injectable so all of this is unit-tested without the network.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-06-01';

const DEFAULT_MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

function hasAnthropic(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY);
}

/**
 * One Messages API call. Returns the parsed response JSON (content blocks,
 * stop_reason, …). Throws on non-2xx.
 */
async function anthropicMessage({
  system,
  messages,
  tools,
  maxTokens = 8000,
  effort = 'medium',
  model = DEFAULT_MODEL(),
  apiKey = process.env.ANTHROPIC_API_KEY,
  fetchImpl = fetch,
}) {
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
    output_config: { effort },
  };
  // The server-side refusal fallback re-runs a classifier-declined request on
  // Opus 4.8 — only meaningful when the requested model is Fable/Mythos tier.
  if (/^claude-(fable|mythos)/.test(model)) {
    body.fallbacks = [{ model: 'claude-opus-4-8' }];
  }
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = { type: 'auto' };
  }

  const post = (payload, beta) =>
    fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
        ...(beta ? { 'anthropic-beta': beta } : {}),
      },
      body: JSON.stringify(payload),
    });

  let res = await post(body, body.fallbacks ? FALLBACK_BETA : null);
  if (res.status === 400 && body.fallbacks) {
    // Most likely the fallbacks beta isn't enabled for this account — retry
    // plain so a policy hiccup can't take the whole brain down.
    const { fallbacks, ...plain } = body;
    res = await post(plain, null);
  }
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
  return res.json();
}

/** Concatenated text blocks of a response (the spoken answer). */
function textFrom(response) {
  return ((response && response.content) || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** The tool_use blocks of a response (empty array when it's a final answer). */
function toolUsesFrom(response) {
  return ((response && response.content) || []).filter((b) => b.type === 'tool_use');
}

/** Convert our OpenAI-style function tools (ghlClient.TOOLS) to Anthropic's shape. */
function toAnthropicTools(openaiTools) {
  return (openaiTools || []).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters || { type: 'object', properties: {} },
  }));
}

module.exports = { hasAnthropic, anthropicMessage, textFrom, toolUsesFrom, toAnthropicTools, DEFAULT_MODEL, API_URL };
