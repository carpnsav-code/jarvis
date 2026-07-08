'use strict';

/**
 * Persistent memory: conversation history + a separate list of durable facts,
 * saved across sessions to a single JSON file under the fixed ~/.jarvis dir.
 *
 * Durability is the whole point, so writes are careful:
 *
 *   - **Atomic**: write to `memory.json.tmp`, then rename it over `memory.json`.
 *     A rename is atomic on a filesystem, so a crash mid-write leaves the old
 *     file intact — never a half-written, unparseable one.
 *   - **Backed up**: right before overwriting, the last good `memory.json` is
 *     copied to `memory.backup.json`. If the main file is ever unreadable, load
 *     falls back to the backup.
 *   - **Flushable**: normal turns debounce their save, but `flush()` writes
 *     synchronously and is safe to call during teardown — the app forces one on
 *     close rather than trusting a debounce timer to fire in time.
 */

const fs = require('fs');
const path = require('path');
const { MEMORY_FILE, BACKUP_FILE } = require('./paths');
const defaultLogger = require('./missionLog');

const empty = () => ({ version: 1, history: [], facts: [] });

function normalise(data) {
  const out = empty();
  if (data && Array.isArray(data.history)) out.history = data.history;
  if (data && Array.isArray(data.facts)) {
    // Tolerate either ["fact"] or [{text,ts}] shapes.
    out.facts = data.facts
      .map((f) => (typeof f === 'string' ? { text: f, ts: Date.now() } : f))
      .filter((f) => f && typeof f.text === 'string' && f.text.trim());
  }
  return out;
}

class MemoryStore {
  constructor({ file = MEMORY_FILE, backup = BACKUP_FILE, debounceMs = 800, logger = defaultLogger } = {}) {
    this.file = file;
    this.backup = backup;
    this.debounceMs = debounceMs;
    this.logger = logger;
    this.timer = null;
    this.data = this.load();
  }

  /** Load from the main file, falling back to the backup if it's unreadable. */
  load() {
    for (const f of [this.file, this.backup]) {
      try {
        if (fs.existsSync(f)) return normalise(JSON.parse(fs.readFileSync(f, 'utf8')));
      } catch (err) {
        this.logger.warn(`memory: ${path.basename(f)} unreadable (${err.message})`);
      }
    }
    return empty();
  }

  addTurn(role, content) {
    this.data.history.push({ role, content, ts: Date.now() });
    this.scheduleSave();
  }

  /** Add new facts, skipping ones we already have. Returns how many were added. */
  addFacts(texts) {
    const seen = new Set(this.data.facts.map((f) => f.text.toLowerCase()));
    let added = 0;
    for (const raw of texts || []) {
      const text = String(raw || '').trim();
      if (!text || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      this.data.facts.push({ text, ts: Date.now() });
      added += 1;
    }
    if (added) this.scheduleSave();
    return added;
  }

  getFacts() {
    return this.data.facts.map((f) => f.text);
  }

  getHistory() {
    return this.data.history;
  }

  /**
   * The stored facts formatted as a context block to inject into an AI call, so
   * the assistant actually uses what it remembers. Empty string when there's
   * nothing to inject.
   */
  factsContext() {
    const facts = this.getFacts();
    if (!facts.length) return '';
    return ['What you remember about the user:', ...facts.map((f) => `- ${f}`)].join('\n');
  }

  scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.flush();
      } catch (err) {
        this.logger.error(`memory: debounced save failed — ${err.message}`);
      }
    }, this.debounceMs);
    // Don't let a pending save keep the process alive.
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Write now, synchronously: backup the last good file, then atomically
   * replace the main file via tmp + rename. Safe to call during teardown.
   */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });

    // Refresh the backup from the last good main file BEFORE we overwrite it,
    // so there is always a usable fallback if this write is bad.
    if (fs.existsSync(this.file)) {
      try {
        fs.copyFileSync(this.file, this.backup);
      } catch (err) {
        this.logger.warn(`memory: backup refresh failed — ${err.message}`);
      }
    }

    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file); // atomic replace
  }
}

module.exports = { MemoryStore, normalise };
