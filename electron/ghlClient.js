'use strict';

/**
 * Live GoHighLevel client — lets Jarvis actually operate the CRM (not just talk
 * about it). Mirrors the GHL agent repo's client + tools: same base URL, API
 * version, Bearer auth, and location scoping. Credentials come from
 * GHL_API_TOKEN and GHL_LOCATION_ID (env only, never the renderer).
 *
 * `TOOLS` is the OpenAI/Groq function-calling schema for the subset Jarvis can
 * drive by voice; `dispatch()` maps a tool name + args to a real API call.
 * fetch is injectable so the request building is testable without a token.
 */

const BASE_URL = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';
// The calendar is round-robin: any create/reschedule WITHOUT an explicit
// assignedUserId re-rolls the appointment onto the wrong user and it vanishes
// from Dan's calendar. Enforced in code, not just prompts. (From the GHL
// session handoff; override with GHL_APPOINTMENT_USER_ID.)
const DEFAULT_APPOINTMENT_USER = () => process.env.GHL_APPOINTMENT_USER_ID || '6pvVVC5ph1zf9m5Z7IKj';

// The account's calendar date in America/Phoenix — NOT UTC. The server clock is
// UTC, and Phoenix is 7 hours behind it, so any time after ~5pm Phoenix the UTC
// date has already rolled to tomorrow. GHL rejects an issueDate/dueDate that
// looks like it's in the future, so every date sent to the API must be computed
// in the business's own timezone, not the server's.
function phoenixDateString(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  // en-CA gives YYYY-MM-DD directly.
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
}

// Append a custom note to a template's terms/notes, tolerating whatever shape
// the API returns termsNotes in (string, {text}, {html}, or absent).
function appendNote(termsNotes, note) {
  if (!note) return termsNotes;
  const line = `Note: ${note}`;
  if (typeof termsNotes === 'string') return termsNotes ? `${termsNotes}\n\n${line}` : line;
  if (termsNotes && typeof termsNotes === 'object') {
    if (typeof termsNotes.text === 'string') return { ...termsNotes, text: `${termsNotes.text}\n\n${line}` };
    if (typeof termsNotes.html === 'string') return { ...termsNotes, html: `${termsNotes.html}<br/><br/>${line}` };
    return termsNotes;
  }
  return line;
}

class GHLClient {
  constructor({ token = process.env.GHL_API_TOKEN, locationId = process.env.GHL_LOCATION_ID, fetchImpl = fetch } = {}) {
    this.token = token;
    this.locationId = locationId;
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.token && this.locationId);
  }

  async request(method, path, { query = {}, body } = {}) {
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Version: API_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    // Check status BEFORE parsing — GHL error bodies aren't always JSON.
    if (!res.ok) throw new Error(`GHL API ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  }

  // --- Contacts ---
  listContacts({ query, limit = 20 } = {}) {
    return this.request('GET', '/contacts/', { query: { locationId: this.locationId, query, limit } });
  }
  createContact(fields) {
    return this.request('POST', '/contacts/', { body: { locationId: this.locationId, ...fields } });
  }

  addContactTags({ contactId, tags }) {
    return this.request('POST', `/contacts/${contactId}/tags`, { body: { tags } });
  }
  /** Newest contacts first — the GET list endpoint has no reliable order, so
   *  "latest lead" questions must use this search endpoint's sort. */
  latestContacts({ limit = 10 } = {}) {
    return this.request('POST', '/contacts/search', {
      body: {
        locationId: this.locationId,
        pageLimit: Math.min(Number(limit) || 10, 50),
        sort: [{ field: 'dateAdded', direction: 'desc' }],
      },
    });
  }

  // --- Pipelines & opportunities ---
  listPipelines() {
    return this.request('GET', '/opportunities/pipelines', { query: { locationId: this.locationId } });
  }
  listOpportunities({ pipelineId, status, query, limit = 20 } = {}) {
    return this.request('GET', '/opportunities/search', {
      query: { location_id: this.locationId, pipeline_id: pipelineId, status, q: query, limit },
    });
  }
  updateOpportunity({ opportunityId, ...fields }) {
    return this.request('PUT', `/opportunities/${opportunityId}`, { body: fields });
  }

  // --- Calendar ---
  listCalendars() {
    return this.request('GET', '/calendars/', { query: { locationId: this.locationId } });
  }
  listAppointments({ startTime, endTime, calendarId } = {}) {
    return this.request('GET', '/calendars/events', {
      query: { locationId: this.locationId, startTime, endTime, calendarId },
    });
  }
  getFreeSlots({ calendarId, startDate, endDate, timezone, userId }) {
    // Round-robin availability differs per user — check Dan's slots by default.
    return this.request('GET', `/calendars/${calendarId}/free-slots`, {
      query: { startDate, endDate, timezone, userId: userId || DEFAULT_APPOINTMENT_USER() },
    });
  }
  createAppointment({ calendarId, contactId, startTime, endTime, title, assignedUserId }) {
    return this.request('POST', '/calendars/events/appointments', {
      body: {
        locationId: this.locationId,
        calendarId,
        contactId,
        startTime,
        endTime,
        title,
        appointmentStatus: 'confirmed',
        assignedUserId: assignedUserId || DEFAULT_APPOINTMENT_USER(),
      },
    });
  }

  // --- Estimates (quotes) — Dan's SOP in one atomic call ---------------------
  listEstimateTemplates() {
    return this.request('GET', '/invoices/estimate/template', {
      query: { altId: this.locationId, altType: 'location', limit: 50, offset: 0 },
    });
  }

  /**
   * The whole quote SOP: pick the prebuilt template, attach the customer, set
   * square footage (= quantity) and price per sq ft (= unit price), send via
   * text AND email. Encodes the API's learned quirks: frequencySettings is
   * required, the send call needs a userId, and the name must be ≤ 40 chars.
   */
  async sendQuote({ contactName, contactId, templateName, squareFeet, pricePerSquareFoot, title, note }) {
    const norm = (s) => String(s || '').toLowerCase();

    // 1. the customer
    let contact = null;
    if (contactId) {
      const d = await this.request('GET', `/contacts/${contactId}`);
      contact = d.contact || d;
    } else {
      const d = await this.listContacts({ query: contactName, limit: 10 });
      const tokens = norm(contactName).split(/\s+/).filter(Boolean);
      const nameOf = (c) => norm(c.contactName || `${c.firstName || ''} ${c.lastName || ''}`);
      contact = (d.contacts || []).find((c) => tokens.every((tk) => nameOf(c).includes(tk)));
    }
    if (!contact) throw new Error(`No contact found matching "${contactName}"`);

    // 2. the prebuilt template
    const tpls = ((await this.listEstimateTemplates()).data || []);
    const want = norm(templateName).replace(/\bsystem\b/g, '').trim();
    const wantTokens = want.split(/\s+/).filter(Boolean);
    let template =
      tpls.find((t) => wantTokens.every((tk) => norm(t.name).includes(tk))) ||
      tpls.find((t) => wantTokens.some((tk) => tk.length > 3 && norm(t.name).includes(tk)));
    if (!template) {
      throw new Error(`No estimate template matching "${templateName}". Available: ${tpls.map((t) => t.name).join(', ')}`);
    }

    // 3. fill it out: sqft = quantity, $/sqft = per-unit price
    const item = { ...template.items[0], qty: Number(squareFeet), amount: Number(pricePerSquareFoot) };
    delete item._id;
    const created = await this.request('POST', '/invoices/estimate', {
      body: {
        altId: this.locationId,
        altType: 'location',
        liveMode: true,
        name: String(title || template.name).slice(0, 40), // API 422s past 40 chars
        title: template.title || 'ESTIMATE',
        currency: 'USD',
        businessDetails: template.businessDetails,
        contactDetails: {
          id: contact.id,
          name: contact.contactName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
          email: contact.email,
          phoneNo: contact.phone,
        },
        items: [item],
        discount: template.discount || { value: 0, type: 'percentage' },
        termsNotes: appendNote(template.termsNotes, note),
        frequencySettings: { enabled: false },
        issueDate: phoenixDateString(),
        expiryDate: phoenixDateString(30),
      },
    });
    const estimateId = created._id || (created.estimate && created.estimate._id);
    if (!estimateId) throw new Error('Estimate creation returned no id');

    // 4. send via text AND email (userId is required by the API)
    await this.request('POST', `/invoices/estimate/${estimateId}/send`, {
      body: {
        altId: this.locationId,
        altType: 'location',
        userId: DEFAULT_APPOINTMENT_USER(),
        action: 'sms_and_email',
        liveMode: true,
      },
    });

    return {
      estimateId,
      contact: contact.contactName || contactName,
      template: template.name,
      squareFeet: Number(squareFeet),
      pricePerSquareFoot: Number(pricePerSquareFoot),
      total: Number(squareFeet) * Number(pricePerSquareFoot),
      note: note || undefined,
    };
  }

  // --- Invoices — same SOP as estimates, but it's an invoice and it's due today.
  listInvoiceTemplates() {
    return this.request('GET', '/invoices/template', {
      query: { altId: this.locationId, altType: 'location', limit: 50, offset: 0 },
    });
  }

  /**
   * Create and send an invoice from a prebuilt template: quantity = qty,
   * price per unit = amount, sent by text AND email, due today. Mirrors
   * sendQuote's learned quirks (frequencySettings required, send needs a userId,
   * name ≤ 40 chars).
   */
  async sendInvoice({ contactName, contactId, templateName, quantity, amount, title, note }) {
    const norm = (s) => String(s || '').toLowerCase();

    // 1. the customer
    let contact = null;
    if (contactId) {
      const d = await this.request('GET', `/contacts/${contactId}`);
      contact = d.contact || d;
    } else {
      const d = await this.listContacts({ query: contactName, limit: 10 });
      const tokens = norm(contactName).split(/\s+/).filter(Boolean);
      const nameOf = (c) => norm(c.contactName || `${c.firstName || ''} ${c.lastName || ''}`);
      contact = (d.contacts || []).find((c) => tokens.every((tk) => nameOf(c).includes(tk)));
    }
    if (!contact) throw new Error(`No contact found matching "${contactName}"`);

    // 2. the prebuilt template (fall back to estimate templates if no invoice
    //    templates exist — the account's saved designs live there)
    let tpls = ((await this.listInvoiceTemplates()).data || []);
    if (!tpls.length) tpls = ((await this.listEstimateTemplates()).data || []);
    const want = norm(templateName).replace(/\bsystem\b/g, '').trim();
    const wantTokens = want.split(/\s+/).filter(Boolean);
    const template =
      tpls.find((t) => wantTokens.every((tk) => norm(t.name).includes(tk))) ||
      tpls.find((t) => wantTokens.some((tk) => tk.length > 3 && norm(t.name).includes(tk)));
    if (!template) {
      throw new Error(`No template matching "${templateName}". Available: ${tpls.map((t) => t.name).join(', ')}`);
    }

    // 3. fill it out: quantity = qty, $/unit = per-unit price
    const item = { ...template.items[0], qty: Number(quantity), amount: Number(amount) };
    delete item._id;
    const today = phoenixDateString();
    const created = await this.request('POST', '/invoices/', {
      body: {
        altId: this.locationId,
        altType: 'location',
        liveMode: true,
        name: String(title || template.name).slice(0, 40),
        title: template.title || 'INVOICE',
        currency: 'USD',
        businessDetails: template.businessDetails,
        contactDetails: {
          id: contact.id,
          name: contact.contactName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
          email: contact.email,
          phoneNo: contact.phone,
        },
        items: [item],
        discount: template.discount || { value: 0, type: 'percentage' },
        termsNotes: appendNote(template.termsNotes, note),
        frequencySettings: { enabled: false },
        issueDate: today,
        dueDate: today, // invoices are due the same day they're sent
      },
    });
    const invoiceId = created._id || (created.invoice && created.invoice._id);
    if (!invoiceId) throw new Error('Invoice creation returned no id');

    // 4. send via text AND email (userId is required by the API)
    await this.request('POST', `/invoices/${invoiceId}/send`, {
      body: {
        altId: this.locationId,
        altType: 'location',
        userId: DEFAULT_APPOINTMENT_USER(),
        action: 'sms_and_email',
        liveMode: true,
      },
    });

    return {
      invoiceId,
      contact: contact.contactName || contactName,
      template: template.name,
      quantity: Number(quantity),
      amount: Number(amount),
      total: Number(quantity) * Number(amount),
      dueDate: today,
      note: note || undefined,
    };
  }

  /**
   * Match a spoken template name against the real saved templates so the flow
   * can disambiguate ("polished" -> 200/400/800 grit) and show the exact name.
   * @returns {Promise<{all: string[], matches: string[]}>}
   */
  async findTemplates({ kind, name }) {
    let tpls = kind === 'invoice' ? ((await this.listInvoiceTemplates()).data || []) : ((await this.listEstimateTemplates()).data || []);
    if (kind === 'invoice' && !tpls.length) tpls = ((await this.listEstimateTemplates()).data || []);
    const norm = (s) => String(s || '').toLowerCase();
    const want = norm(name).replace(/\b(system|concrete|template)\b/g, '').trim();
    const wantTokens = want.split(/\s+/).filter(Boolean);
    const all = tpls.map((t) => t.name);
    if (!wantTokens.length) return { all, matches: [] };
    const strict = tpls.filter((t) => wantTokens.every((tk) => norm(t.name).includes(tk)));
    const loose = tpls.filter((t) => wantTokens.some((tk) => tk.length > 2 && norm(t.name).includes(tk)));
    return { all, matches: (strict.length ? strict : loose).map((t) => t.name) };
  }

  // --- Conversations ---
  listConversations({ contactId, limit = 20 } = {}) {
    return this.request('GET', '/conversations/search', {
      query: { locationId: this.locationId, contactId, limit },
    });
  }
  sendMessage({ contactId, type, message, subject }) {
    return this.request('POST', '/conversations/messages', {
      body: { contactId, type, message, ...(type === 'Email' ? { subject } : {}) },
    });
  }

  /** Execute a named tool with parsed args. */
  async dispatch(name, args = {}) {
    switch (name) {
      case 'ghl_list_contacts':
        return this.listContacts(args);
      case 'ghl_create_contact':
        return this.createContact(args);
      case 'ghl_add_contact_tags':
        return this.addContactTags(args);
      case 'ghl_latest_leads':
        return this.latestContacts(args);
      case 'ghl_list_pipelines':
        return this.listPipelines();
      case 'ghl_list_opportunities':
        return this.listOpportunities(args);
      case 'ghl_update_opportunity':
        return this.updateOpportunity(args);
      case 'ghl_list_calendars':
        return this.listCalendars();
      case 'ghl_list_appointments':
        return this.listAppointments(args);
      case 'ghl_get_free_slots':
        return this.getFreeSlots(args);
      case 'ghl_create_appointment':
        return this.createAppointment(args);
      case 'ghl_list_conversations':
        return this.listConversations(args);
      case 'ghl_send_message':
        return this.sendMessage(args);
      case 'ghl_list_estimate_templates':
        return this.listEstimateTemplates();
      case 'ghl_send_quote':
        return this.sendQuote(args);
      default:
        throw new Error(`Unknown GHL tool: ${name}`);
    }
  }
}

// Function-calling schema exposed to the model.
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'ghl_list_contacts',
      description: 'List or search contacts in the GoHighLevel account.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text search by name, email, or phone' },
          limit: { type: 'integer', description: '1-100, default 20' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_create_contact',
      description: 'Create a new contact.',
      parameters: {
        type: 'object',
        properties: {
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_list_pipelines',
      description: 'List sales pipelines and their stages.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_list_opportunities',
      description: 'List/search opportunities (deals). Use status "open" for open deals.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'won', 'lost', 'abandoned', 'all'] },
          query: { type: 'string' },
          pipelineId: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_latest_leads',
      description: 'The newest leads/contacts, sorted newest first. ALWAYS use this for "latest/last/newest lead(s) or contact(s)" questions.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: 'How many, default 10' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_add_contact_tags',
      description: 'Add one or more tags to a contact (find contactId with ghl_list_contacts).',
      parameters: {
        type: 'object',
        properties: {
          contactId: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['contactId', 'tags'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_update_opportunity',
      description: 'Update a deal: move it to another stage (pipelineStageId from ghl_list_pipelines), change its value, or mark it won/lost.',
      parameters: {
        type: 'object',
        properties: {
          opportunityId: { type: 'string' },
          name: { type: 'string' },
          pipelineStageId: { type: 'string' },
          monetaryValue: { type: 'number' },
          status: { type: 'string', enum: ['open', 'won', 'lost', 'abandoned'] },
        },
        required: ['opportunityId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_list_calendars',
      description: 'List calendars in the account (to get a calendarId).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_get_free_slots',
      description: 'Check available booking slots on a calendar between two dates.',
      parameters: {
        type: 'object',
        properties: {
          calendarId: { type: 'string' },
          startDate: { type: 'string', description: 'ISO date or epoch millis' },
          endDate: { type: 'string', description: 'ISO date or epoch millis' },
          timezone: { type: 'string' },
        },
        required: ['calendarId', 'startDate', 'endDate'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_create_appointment',
      description: 'Book an appointment for a contact on a calendar (ISO start/end times).',
      parameters: {
        type: 'object',
        properties: {
          calendarId: { type: 'string' },
          contactId: { type: 'string' },
          startTime: { type: 'string' },
          endTime: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['calendarId', 'contactId', 'startTime', 'endTime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_send_quote',
      description:
        'Create AND send an estimate/quote from a prebuilt template via text and email, in one step (the SOP). ' +
        'Use whenever Dan says to send a quote or estimate. The price must come from Dan — never invent it.',
      parameters: {
        type: 'object',
        properties: {
          contactName: { type: 'string', description: 'Customer name as Dan said it' },
          templateName: { type: 'string', description: 'Which template: flake, marble metallic, single color epoxy, grind and seal, stained, 200/400/800 grit polished' },
          squareFeet: { type: 'number' },
          pricePerSquareFoot: { type: 'number' },
          title: { type: 'string', description: 'Optional short estimate name (max 40 chars)' },
        },
        required: ['contactName', 'templateName', 'squareFeet', 'pricePerSquareFoot'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_list_estimate_templates',
      description: 'List the prebuilt estimate templates and their default per-sq-ft pricing.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_list_conversations',
      description: 'List recent conversation threads, optionally for one contact.',
      parameters: {
        type: 'object',
        properties: {
          contactId: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_list_appointments',
      description: 'List appointments in a time range. Times are ISO 8601 or epoch millis.',
      parameters: {
        type: 'object',
        properties: {
          startTime: { type: 'string' },
          endTime: { type: 'string' },
          calendarId: { type: 'string' },
        },
        required: ['startTime', 'endTime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_send_message',
      description: 'Send an SMS or Email to a contact by contactId. Find the contactId with ghl_list_contacts first.',
      parameters: {
        type: 'object',
        properties: {
          contactId: { type: 'string' },
          type: { type: 'string', enum: ['SMS', 'Email'] },
          message: { type: 'string' },
          subject: { type: 'string', description: 'Required for Email' },
        },
        required: ['contactId', 'type', 'message'],
      },
    },
  },
];

module.exports = { GHLClient, TOOLS, BASE_URL, API_VERSION };
