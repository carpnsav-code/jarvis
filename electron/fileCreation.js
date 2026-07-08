'use strict';

/**
 * File creation (guide Pro item): generate a PDF or document from a spoken
 * request and save it straight to the Desktop. The brain writes the content;
 * this module parses the command, builds the file, and saves it with a tidy,
 * timestamped name.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildPdf } = require('./documentBuilder');

/** The Desktop dir, falling back to the home dir if there isn't one. */
function desktopDir(home = os.homedir()) {
  const desktop = path.join(home, 'Desktop');
  try {
    if (fs.existsSync(desktop)) return desktop;
  } catch {
    /* ignore */
  }
  return home;
}

function slugify(text) {
  return String(text || 'document')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'document';
}

/**
 * Parse a file-creation command, or null.
 *   "create a pdf about the solar system"  → { kind:'pdf',  topic:'the solar system' }
 *   "make a document about my trip"        → { kind:'doc',  topic:'my trip' }
 *   "write a note to buy milk"             → { kind:'note', topic:'buy milk' }
 *
 * @param {string} text
 * @returns {{kind:'pdf'|'doc'|'note', topic:string}|null}
 */
function parseCreateCommand(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;

  const pdf = t.match(/\b(?:create|make|generate|write|build)\s+(?:a\s+|an\s+)?pdf\s+(?:about|on|for|of|titled|called)?\s*(.*)/);
  if (pdf) return { kind: 'pdf', topic: pdf[1].trim() };

  const doc = t.match(/\b(?:create|make|generate|write|save)\s+(?:a\s+|an\s+)?(?:document|doc|file|report|essay)\s+(?:about|on|for|of|titled|called)?\s*(.*)/);
  if (doc) return { kind: 'doc', topic: doc[1].trim() };

  const note = t.match(/\b(?:write|save|take|make|create)\s+(?:a\s+|an\s+)?note\s+(?:about|on|to|that|saying)?\s*(.*)/);
  if (note) return { kind: 'note', topic: note[1].trim() };

  return null;
}

/**
 * Build and save a file to the Desktop.
 *
 * @param {{kind:string, title:string, body:string}} spec
 * @param {{dir?:string, now?:Date}} [opts]
 * @returns {{ok:true, path:string, kind:string}}
 */
function createFile({ kind, title, body }, { dir = desktopDir(), now = new Date() } = {}) {
  const stamp = now.toISOString().slice(0, 10);
  const base = `${slugify(title)}-${stamp}`;
  fs.mkdirSync(dir, { recursive: true });

  let filePath;
  if (kind === 'pdf') {
    filePath = path.join(dir, `${base}.pdf`);
    fs.writeFileSync(filePath, buildPdf(title, body));
  } else {
    // doc / note → plain text (markdown-friendly).
    filePath = path.join(dir, `${base}.txt`);
    const heading = title ? `${title}\n${'='.repeat(title.length)}\n\n` : '';
    fs.writeFileSync(filePath, heading + (body || ''), 'utf8');
  }
  return { ok: true, path: filePath, kind };
}

module.exports = { parseCreateCommand, createFile, desktopDir, slugify };
