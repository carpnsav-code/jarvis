'use strict';

/**
 * Loads Jarvis's "training" — the markdown files under knowledge/ — and returns
 * them as one block to inject into the brain's system prompt. This is how Jarvis
 * knows about things like the GHL agent: drop a .md file in knowledge/ and he
 * can talk about it. No fine-tuning needed; it's retrieval by always-include.
 */

const fs = require('fs');
const path = require('path');

const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');
// Keep the injected block bounded so the prompt stays fast.
const MAX_CHARS = 12000;

/**
 * @returns {string} concatenated knowledge, or '' if none.
 */
function loadKnowledge(dir = KNOWLEDGE_DIR) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return '';
  }
  const parts = [];
  for (const file of files) {
    try {
      parts.push(fs.readFileSync(path.join(dir, file), 'utf8').trim());
    } catch {
      /* skip unreadable */
    }
  }
  const combined = parts.join('\n\n---\n\n');
  return combined.length > MAX_CHARS ? `${combined.slice(0, MAX_CHARS)}\n…(truncated)` : combined;
}

module.exports = { loadKnowledge, KNOWLEDGE_DIR };
