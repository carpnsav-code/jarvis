'use strict';

/**
 * The mission log — the assistant's diagnostic log.
 *
 * Two sinks: the console (so it shows up in dev) and an append-only file under
 * the fixed ~/.jarvis dir (so failures are still visible after the fact). It is
 * intentionally forgiving: logging must never throw, so a failure to write the
 * file is swallowed rather than allowed to cascade into the thing being logged.
 *
 * Background jobs (like memory fact extraction) route their errors here so a
 * silent failure becomes a visible line instead of vanishing.
 */

const fs = require('fs');
const path = require('path');
const { MISSION_LOG } = require('./paths');

// Test hook: when set, lines go here instead of console/file.
let sink = null;

function emit(level, message) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${message}`;

  if (sink) {
    sink({ level, message, line });
    return;
  }

  (level === 'error' ? console.error : console.log)(line);
  try {
    fs.mkdirSync(path.dirname(MISSION_LOG), { recursive: true });
    fs.appendFileSync(MISSION_LOG, line + '\n');
  } catch {
    /* logging must never throw */
  }
}

module.exports = {
  info: (m) => emit('info', m),
  warn: (m) => emit('warn', m),
  error: (m) => emit('error', m),
  path: MISSION_LOG,
  // test helpers
  _setSink: (fn) => {
    sink = fn;
  },
  _reset: () => {
    sink = null;
  },
};
