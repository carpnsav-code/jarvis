'use strict';

/**
 * Lightweight app integrations (guide Pro item), the keyless way: instead of a
 * full OAuth flow per service, we open the service's own compose/create page
 * with the details pre-filled via URL parameters. "Draft an email to Sam about
 * lunch" opens Gmail's compose window already addressed; "add a calendar event
 * dentist on Friday" opens Google Calendar's event template.
 *
 * The parsing is pure and tested; main.js opens the returned URL in the browser.
 */

function normalise(text) {
  return String(text == null ? '' : text).trim();
}

/**
 * Parse an email or calendar command, or null.
 *   "email sam@x.com about lunch tomorrow"        → email
 *   "draft an email to sam@x.com saying I'm late" → email
 *   "add a calendar event dentist on Friday 3pm"  → calendar
 *   "schedule a meeting with the team monday"     → calendar
 *
 * @param {string} text
 * @returns {object|null}
 */
function parseProductivityCommand(text) {
  const t = normalise(text);
  const lower = t.toLowerCase();

  // Email: capture recipient and the topic/body.
  const email = t.match(/\b(?:email|draft an email to|send an email to|write an email to|send a mail to)\s+(\S+@\S+|[a-z]+)\s*(?:\b(?:about|regarding|saying|re)\b\s*)?(.*)$/i);
  if (email && /email|mail/i.test(lower)) {
    const to = email[1].includes('@') ? email[1] : '';
    const rest = email[2].trim();
    return { kind: 'email', to, subject: rest, body: '' };
  }

  // Calendar.
  const cal = t.match(/\b(?:add (?:a )?calendar event|schedule|create (?:a )?event|put on my calendar|add to my calendar)\s+(.*)$/i);
  if (cal) {
    let rest = cal[1].trim();
    let when = '';
    const w = rest.match(/\b(?:on|at|for)\s+(.+)$/i);
    if (w) {
      when = w[1].trim();
      rest = rest.slice(0, w.index).trim();
    }
    return { kind: 'calendar', title: rest || 'New event', when };
  }

  return null;
}

/** Gmail compose deep link with recipient/subject/body pre-filled. */
function buildGmailComposeUrl({ to = '', subject = '', body = '' }) {
  const params = new URLSearchParams({ view: 'cm', fs: '1' });
  if (to) params.set('to', to);
  if (subject) params.set('su', subject);
  if (body) params.set('body', body);
  return `https://mail.google.com/mail/?${params.toString()}`;
}

/** Google Calendar event-template deep link. */
function buildCalendarUrl({ title = '', details = '', when = '' }) {
  const params = new URLSearchParams({ action: 'TEMPLATE', text: title });
  const detail = [details, when ? `When: ${when}` : ''].filter(Boolean).join('\n');
  if (detail) params.set('details', detail);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Turn a parsed command into a URL to open + a spoken confirmation.
 * @param {object} parsed
 * @returns {{url:string, speech:string}}
 */
function resolveProductivity(parsed) {
  if (parsed.kind === 'email') {
    return {
      url: buildGmailComposeUrl({ to: parsed.to, subject: parsed.subject, body: parsed.body }),
      speech: parsed.to ? `Opening an email to ${parsed.to}.` : 'Opening a new email.',
    };
  }
  return {
    url: buildCalendarUrl({ title: parsed.title, when: parsed.when }),
    speech: `Adding "${parsed.title}"${parsed.when ? ` on ${parsed.when}` : ''} to your calendar.`,
  };
}

module.exports = {
  parseProductivityCommand,
  buildGmailComposeUrl,
  buildCalendarUrl,
  resolveProductivity,
};
