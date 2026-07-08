'use strict';

/**
 * A tiny, dependency-free PDF writer — enough to turn a title + body of text
 * into a real, valid multi-page PDF (Helvetica, wrapped lines, proper xref).
 *
 * We build our own rather than pull in a PDF library so file creation stays in
 * the same "npm install and go" spirit as the rest of the app. The output is a
 * Buffer the caller writes to disk.
 */

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 54;
const FONT_SIZE = 12;
const LEADING = 16;
const TITLE_SIZE = 18;
const MAX_CHARS = 92; // ~ line width at 12pt Helvetica within the margins
const LINES_PER_PAGE = Math.floor((PAGE_H - MARGIN * 2 - 30) / LEADING);

/** Escape a string for a PDF literal: (, ), \ and drop non-ASCII. */
function escapePdfText(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7e]/g, '?');
}

/** Greedy word-wrap to a max character width. */
function wrapText(text, maxChars = MAX_CHARS) {
  const lines = [];
  for (const raw of String(text || '').split('\n')) {
    const words = raw.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      if (line && line.length + 1 + word.length > maxChars) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Build one page's content stream from its lines (title only on page 1). */
function pageContent(lines, title) {
  const parts = ['BT'];
  let y = PAGE_H - MARGIN;
  if (title) {
    parts.push(`/F1 ${TITLE_SIZE} Tf`, `${MARGIN} ${y} Td`, `(${escapePdfText(title)}) Tj`);
    y -= TITLE_SIZE + 10;
    parts.push(`/F1 ${FONT_SIZE} Tf`, `${MARGIN} ${y} Td`);
  } else {
    parts.push(`/F1 ${FONT_SIZE} Tf`, `${MARGIN} ${y} Td`);
  }
  let first = true;
  for (const line of lines) {
    if (first) {
      parts.push(`(${escapePdfText(line)}) Tj`);
      first = false;
    } else {
      parts.push(`0 -${LEADING} Td`, `(${escapePdfText(line)}) Tj`);
    }
  }
  parts.push('ET');
  return parts.join('\n');
}

/**
 * Build a PDF from a title and body text.
 * @param {string} title
 * @param {string} body
 * @returns {Buffer}
 */
function buildPdf(title, body) {
  const allLines = wrapText(body);
  // Page 1 has fewer body lines because of the title block.
  const pages = [];
  const firstPageCap = LINES_PER_PAGE - 2;
  pages.push(allLines.slice(0, firstPageCap));
  for (let i = firstPageCap; i < allLines.length; i += LINES_PER_PAGE) {
    pages.push(allLines.slice(i, i + LINES_PER_PAGE));
  }
  if (pages.length === 0) pages.push([]);

  const P = pages.length;
  // Object layout: 1 catalog, 2 pages, 3 font, 4..3+P page objs, 4+P..3+2P content objs.
  const pageObjStart = 4;
  const contentObjStart = 4 + P;

  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, i) => `${pageObjStart + i} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${P} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  for (let i = 0; i < P; i++) {
    const contentRef = contentObjStart + i;
    objects[pageObjStart + i] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentRef} 0 R >>`;
  }
  for (let i = 0; i < P; i++) {
    const stream = pageContent(pages[i], i === 0 ? title : '');
    objects[contentObjStart + i] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  }

  // Serialize with byte offsets for the xref table.
  const total = objects.length - 1; // objects[0] unused
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let n = 1; n <= total; n++) {
    offsets[n] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${total + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let n = 1; n <= total; n++) {
    pdf += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

module.exports = { buildPdf, wrapText, escapePdfText };
