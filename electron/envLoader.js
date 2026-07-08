'use strict';

/**
 * Minimal .env loader (no dependency).
 *
 * Reads KEY=VALUE lines from the repo-root .env and electron/.env, and sets any
 * that aren't already defined in the real environment. This lets a user just
 * fill in .env and run `npm start` instead of prefixing keys on the command
 * line. Real environment variables always win, so nothing here overrides them.
 *
 * Intentionally forgiving: a missing or malformed file is silently skipped —
 * the app runs keyless either way.
 */

const fs = require('fs');
const path = require('path');

function parseAndApply(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no file here — fine
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue; // real env wins
    let value = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadEnv() {
  // electron/.env first, then repo-root .env — but neither overrides real env
  // or an earlier file (first writer wins, and real env always wins).
  parseAndApply(path.join(__dirname, '.env'));
  parseAndApply(path.join(__dirname, '..', '.env'));
}

module.exports = { loadEnv };
