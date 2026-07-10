'use strict';

/**
 * Deterministic "leads by pipeline stage" answers.
 *
 * In Dan's world a "lead" is an OPPORTUNITY in the Mint Concrete Polishing
 * pipeline, and the pipeline has stages (New Lead, Quote Sent, Won, Lost, …).
 * "How many leads in the New Lead column?" means: count the opportunities in
 * that stage. "What's the most recent lead?" means: the newest opportunity
 * (in New Lead by default). Jarvis must READ the pipeline for these — never
 * guess, and never treat a lead as a contact — so this path is deterministic:
 * it pulls the opportunities and counts/sorts them itself, no AI in the loop.
 */

const LEAD_WORDS = /\b(leads?|opportunit\w*|deals?|prospects?)\b/i;

function isLeadsQuery(text) {
  const t = String(text || '');
  // Action commands (move/mark a deal, message someone) are not questions — let
  // the deterministic command paths or the agent handle those.
  if (/\b(move|change|mark|set|update|create|add|push|drag|assign|send|text|e-?mail|book|schedule|call)\b/i.test(t)) return false;
  const hasSubject = LEAD_WORDS.test(t) || /\bpipeline\b|\bstages?\b/i.test(t);
  if (!hasSubject) return false;
  return /\bhow many\b|\bcount\b|\bnumber of\b|most recent|newest|latest|\blast\b|\bbreakdown\b|\bpipeline\b|\bstages?\b|\b(?:in|on|inside)\b[^.]*\b(stage|column|section)\b|\b(show|list)\b/i.test(t);
}

/** @returns {{intent:'count'|'latest'|'list'|'overview', stage?:string}} */
function parseLeadsQuery(text) {
  const t = String(text || '').toLowerCase();
  const recent = /\b(most recent|newest|latest|last)\b/.test(t);
  const count = /\bhow many\b|\bcount\b|\bnumber of\b/.test(t);
  const overview = /\bbreakdown\b|\ball (?:my |the )?stages\b|each stage|per stage|every stage|pipeline (?:overview|breakdown|status)|how many leads total|leads in each/.test(t);

  let stage;
  let m = t.match(/\b(?:in|on|inside)\s+(?:the\s+)?(?:my\s+)?([a-z][a-z0-9 &/'-]*?)\s*(?:stage|column|section)\b/);
  if (m) stage = m[1].trim();
  if (!stage) {
    m = t.match(/\b(new leads?|quote sent|quoted|won|lost|dead|no ?show|nurtur\w*|follow[- ]?ups?|booked|scheduled|appointment set|in progress)\b/);
    if (m) stage = m[1].trim();
  }

  let intent;
  if (overview) intent = 'overview';
  else if (recent) intent = 'latest';
  else if (count) intent = 'count';
  else if (/\b(show|list)\b/.test(t)) intent = 'list';
  else intent = stage ? 'count' : 'overview';
  return { intent, stage };
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function findStage(stages, name) {
  if (!name) return null;
  const want = normalize(name);
  const tokens = want.split(/\s+/).filter(Boolean);
  return (
    stages.find((s) => normalize(s.name) === want) ||
    stages.find((s) => tokens.every((tk) => normalize(s.name).includes(tk))) ||
    stages.find((s) => tokens.some((tk) => tk.length > 2 && normalize(s.name).includes(tk))) ||
    null
  );
}
function oppName(o) {
  return o.name || (o.contact && o.contact.name) || `${(o.contact && o.contact.firstName) || ''} ${(o.contact && o.contact.lastName) || ''}`.trim() || 'a lead';
}
function oppDate(o) {
  return new Date(o.createdAt || o.dateAdded || o.added || o.updatedAt || 0).getTime();
}

/**
 * Answer a leads question against the live pipeline.
 * @param {import('./ghlClient').GHLClient} client
 * @param {{intent:string, stage?:string}} q
 * @returns {Promise<string>} spoken answer
 */
async function runLeadsQuery(client, { intent, stage }) {
  if (!client || !client.isConfigured()) {
    return 'Your GoHighLevel account is not connected yet, sir.';
  }
  let pipe, opps;
  try {
    pipe = await client.mintPipeline();
    if (!pipe) return "I couldn't find your pipeline, sir.";
    opps = await client.allOpportunities(pipe.id);
  } catch (err) {
    return `I couldn't read the pipeline, sir — ${String(err.message).slice(0, 90)}`;
  }
  const stages = pipe.stages || [];
  const inStage = (st) => opps.filter((o) => o.pipelineStageId === st.id);

  if (intent === 'overview') {
    if (!stages.length) return `Your pipeline has ${opps.length} opportunities, sir.`;
    const parts = stages.map((s) => `${s.name}, ${inStage(s).length}`);
    return `Here's your pipeline, sir. ${parts.join('; ')}.`;
  }

  // For count / latest / list, default to the New Lead stage when none is named.
  const st = findStage(stages, stage) || (stage ? null : findStage(stages, 'new lead'));
  if (!st) {
    const names = stages.map((s) => s.name).join(', ');
    return `I couldn't find a "${stage}" stage, sir. Your stages are: ${names}.`;
  }
  const rows = inStage(st);

  if (intent === 'count') {
    return `You have ${rows.length} ${rows.length === 1 ? 'lead' : 'leads'} in ${st.name}, sir.`;
  }
  if (intent === 'latest') {
    if (!rows.length) return `There are no leads in ${st.name}, sir.`;
    const newest = rows.slice().sort((a, b) => oppDate(b) - oppDate(a))[0];
    const src = newest.source ? `, from ${newest.source}` : '';
    return `Your most recent lead in ${st.name} is ${oppName(newest)}${src}, sir.`;
  }
  if (intent === 'list') {
    if (!rows.length) return `There are no leads in ${st.name}, sir.`;
    const names = rows.slice().sort((a, b) => oppDate(b) - oppDate(a)).slice(0, 5).map(oppName);
    return `${rows.length} ${rows.length === 1 ? 'lead' : 'leads'} in ${st.name}, sir. The latest: ${names.join(', ')}.`;
  }
  return "I'm not sure what you're after, sir.";
}

module.exports = { isLeadsQuery, parseLeadsQuery, runLeadsQuery, findStage };
