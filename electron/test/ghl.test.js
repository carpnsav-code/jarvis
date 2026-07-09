'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GHLClient, TOOLS } = require('../ghlClient');
const { isGhlQuery, runGhlAgent, _resetModelBench, parseTextCommand, runTextCommand, parseEmailCommand, runEmailCommand } = require('../ghlAgent');

test('parseTextCommand handles the common spoken phrasings', () => {
  assert.deepEqual(parseTextCommand('text harold saying we are on for friday'), { name: 'harold', message: 'we are on for friday' });
  assert.deepEqual(parseTextCommand('send a text to harold williams saying running 10 late'), { name: 'harold williams', message: 'running 10 late' });
  assert.deepEqual(parseTextCommand('text harold and tell him the quote is ready'), { name: 'harold', message: 'the quote is ready' });
  assert.deepEqual(parseTextCommand('send harold a text saying see you at 9'), { name: 'harold', message: 'see you at 9' });
  assert.equal(parseTextCommand('what are my open deals'), null);
});

test('runTextCommand finds the contact by name and sends the SMS', async () => {
  const rec = [];
  const client = new GHLClient({
    token: 't', locationId: 'l',
    fetchImpl: stubFetch([
      ['/contacts/', () => ok({ contacts: [{ id: 'c9', contactName: 'harold williams' }] })],
      ['/conversations/messages', (u, o) => { rec.push(JSON.parse(o.body)); return ok({ ok: true }); }],
    ]),
  });
  const speech = await runTextCommand(client, { name: 'harold', message: 'on my way' });
  assert.match(speech, /Text sent to harold williams/);
  assert.deepEqual(rec[0], { contactId: 'c9', type: 'SMS', message: 'on my way' });
});

test('parseEmailCommand handles common phrasings', () => {
  assert.deepEqual(parseEmailCommand('email harold saying the quote is attached'), { name: 'harold', message: 'the quote is attached' });
  assert.deepEqual(parseEmailCommand('send an email to harold williams saying thanks for your time'), { name: 'harold williams', message: 'thanks for your time' });
  assert.equal(parseEmailCommand('text harold saying hi'), null);
});

test('runEmailCommand sends type Email with a subject; refuses without an email on file', async () => {
  const rec = [];
  const withEmail = new GHLClient({
    token: 't', locationId: 'l',
    fetchImpl: stubFetch([
      ['/contacts/', () => ok({ contacts: [{ id: 'c1', contactName: 'harold williams', email: 'h@x.com' }] })],
      ['/conversations/messages', (u, o) => { rec.push(JSON.parse(o.body)); return ok({}); }],
    ]),
  });
  const speech = await runEmailCommand(withEmail, { name: 'harold', message: 'quote attached' });
  assert.match(speech, /Email sent to harold williams/);
  assert.equal(rec[0].type, 'Email');
  assert.ok(rec[0].subject);

  const noEmail = new GHLClient({
    token: 't', locationId: 'l',
    fetchImpl: stubFetch([['/contacts/', () => ok({ contacts: [{ id: 'c1', contactName: 'harold williams' }] })]]),
  });
  assert.match(await runEmailCommand(noEmail, { name: 'harold', message: 'x' }), /no email address on file/i);
});

test('sendQuote runs the whole SOP: template + customer + sqft×price, sent sms_and_email', async () => {
  const created = [];
  const sent = [];
  const client = new GHLClient({
    token: 't', locationId: 'LOC',
    fetchImpl: stubFetch([
      ['/contacts/', () => ok({ contacts: [{ id: 'c7', contactName: 'harold williams', email: 'h@x.com', phone: '+1555' }] })],
      ['/invoices/estimate/template', () => ok({ data: [{ _id: 'tpl1', name: 'Polyaspartic Flake Flooring System', title: 'ESTIMATE', termsNotes: '<p>terms</p>', businessDetails: { name: 'Mint' }, discount: { value: 0, type: 'percentage' }, items: [{ name: 'Polyaspartic Flake Flooring System', amount: 5, qty: 1, productId: 'p', priceId: 'pr', type: 'one_time', currency: 'USD', taxInclusive: false, _id: 'x' }] }] })],
      ['/invoices/estimate/est9/send', (u, o) => { sent.push(JSON.parse(o.body)); return ok({ estimateStatus: 'sent' }); }],
      ['/invoices/estimate', (u, o) => { created.push(JSON.parse(o.body)); return ok({ _id: 'est9' }); }],
    ]),
  });
  const r = await client.sendQuote({ contactName: 'harold', templateName: 'flake', squareFeet: 600, pricePerSquareFoot: 6 });
  assert.equal(r.total, 3600);
  const body = created[0];
  assert.equal(body.items[0].qty, 600); // sqft = quantity
  assert.equal(body.items[0].amount, 6); // $/sqft = unit price
  assert.deepEqual(body.frequencySettings, { enabled: false }); // required by the API
  assert.ok(body.name.length <= 40); // 422s past 40 chars
  assert.equal(body.termsNotes, '<p>terms</p>'); // template terms carried
  assert.equal(sent[0].action, 'sms_and_email'); // text AND email
  assert.ok(sent[0].userId); // required by the API
});

test('sendQuote refuses on an unknown template and names the real ones', async () => {
  const client = new GHLClient({
    token: 't', locationId: 'l',
    fetchImpl: stubFetch([
      ['/contacts/', () => ok({ contacts: [{ id: 'c1', contactName: 'harold' }] })],
      ['/invoices/estimate/template', () => ok({ data: [{ name: 'Polyaspartic Flake Flooring System', items: [{}] }] })],
    ]),
  });
  await assert.rejects(
    () => client.sendQuote({ contactName: 'harold', templateName: 'zzz-nonexistent', squareFeet: 1, pricePerSquareFoot: 1 }),
    /No estimate template matching/,
  );
});

test('runTextCommand refuses to send when no contact matches the name', async () => {
  let sent = false;
  const client = new GHLClient({
    token: 't', locationId: 'l',
    fetchImpl: stubFetch([
      ['/contacts/', () => ok({ contacts: [{ id: 'x', contactName: 'someone else' }] })],
      ['/conversations/messages', () => { sent = true; return ok({}); }],
    ]),
  });
  const speech = await runTextCommand(client, { name: 'harold', message: 'hi' });
  assert.match(speech, /couldn't find a contact.*no text sent/i);
  assert.equal(sent, false);
});

function stubFetch(handlers, record = []) {
  return async (url, opts) => {
    record.push({ url, opts });
    for (const [needle, fn] of handlers) {
      if (url.includes(needle)) return fn(url, opts);
    }
    throw new Error('unhandled ' + url);
  };
}
const ok = (json) => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });

test('client is configured only with token + location', () => {
  assert.equal(new GHLClient({ token: 't', locationId: 'l' }).isConfigured(), true);
  assert.equal(new GHLClient({ token: 't', locationId: '' }).isConfigured(), false);
  assert.equal(new GHLClient({ token: '', locationId: '' }).isConfigured(), false);
});

test('listOpportunities builds the right query with location + status', async () => {
  const rec = [];
  const c = new GHLClient({ token: 't', locationId: 'LOC', fetchImpl: stubFetch([['/opportunities/search', () => ok({ opportunities: [] })]], rec) });
  await c.listOpportunities({ status: 'open' });
  const u = new URL(rec[0].url);
  assert.equal(u.pathname, '/opportunities/search');
  assert.equal(u.searchParams.get('location_id'), 'LOC');
  assert.equal(u.searchParams.get('status'), 'open');
  assert.equal(rec[0].opts.headers.Version, '2021-07-28');
  assert.match(rec[0].opts.headers.Authorization, /Bearer t/);
});

test('sendMessage posts to conversations with the body', async () => {
  const rec = [];
  const c = new GHLClient({ token: 't', locationId: 'l', fetchImpl: stubFetch([['/conversations/messages', () => ok({ ok: true })]], rec) });
  await c.sendMessage({ contactId: 'c1', type: 'SMS', message: 'hi' });
  assert.equal(rec[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(rec[0].opts.body), { contactId: 'c1', type: 'SMS', message: 'hi' });
});

test('dispatch routes tool names to methods', async () => {
  const c = new GHLClient({ token: 't', locationId: 'l', fetchImpl: stubFetch([['/opportunities/pipelines', () => ok({ pipelines: [{ id: 'p1' }] })]]) });
  const r = await c.dispatch('ghl_list_pipelines', {});
  assert.deepEqual(r, { pipelines: [{ id: 'p1' }] });
});

test('createAppointment always carries an assignedUserId (round-robin fix)', async () => {
  const rec = [];
  const c = new GHLClient({ token: 't', locationId: 'l', fetchImpl: stubFetch([['/calendars/events/appointments', () => ok({ ok: true })]], rec) });
  await c.createAppointment({ calendarId: 'cal', contactId: 'ct', startTime: 'a', endTime: 'b' });
  const body = JSON.parse(rec[0].opts.body);
  assert.ok(body.assignedUserId, 'assignedUserId must default so the appointment lands on Dan\'s calendar');
});

test('getFreeSlots checks per-user availability by default', async () => {
  const rec = [];
  const c = new GHLClient({ token: 't', locationId: 'l', fetchImpl: stubFetch([['/free-slots', () => ok({})]], rec) });
  await c.getFreeSlots({ calendarId: 'cal', startDate: '1', endDate: '2' });
  assert.ok(new URL(rec[0].url).searchParams.get('userId'), 'free slots must be checked for a specific user');
});

test('request throws a clear error on non-2xx', async () => {
  const c = new GHLClient({ token: 't', locationId: 'l', fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }) });
  await assert.rejects(() => c.listContacts(), /HTTP 401/);
});

test('isGhlQuery detects CRM intent', () => {
  assert.equal(isGhlQuery('what are my open deals'), true);
  assert.equal(isGhlQuery('text Sam saying I am late'), true);
  assert.equal(isGhlQuery('list my contacts in ghl'), true);
  assert.equal(isGhlQuery('what is the weather'), false);
});

test('runGhlAgent says not connected without a token', async () => {
  const client = new GHLClient({ token: '', locationId: '' });
  _resetModelBench();
  const speech = await runGhlAgent('open deals', { keys: ['k'], client });
  assert.match(speech, /not connected/i);
});

test('runGhlAgent survives a rate limit: 429 first, succeeds on retry', async () => {
  _resetModelBench();
  const client = new GHLClient({ token: 't', locationId: 'l', fetchImpl: async () => ok({}) });
  let calls = 0;
  const groqImpl = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'You have three open deals, sir.' } }] }) };
  };
  const speech = await runGhlAgent('how many deals', { keys: ['k'], client, groqImpl });
  assert.match(speech, /three open deals/);
  assert.ok(calls >= 2, 'should have retried after the 429');
});

test('runGhlAgent never throws — total AI failure becomes a spoken reply', async () => {
  _resetModelBench();
  const client = new GHLClient({ token: 't', locationId: 'l', fetchImpl: async () => ok({}) });
  const groqImpl = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const speech = await runGhlAgent('list my deals', { keys: ['k'], client, groqImpl });
  assert.match(speech, /rate-limited|snag/i);
});

test('runGhlAgent runs a tool-calling loop and returns the spoken answer', async () => {
  _resetModelBench();
  const client = new GHLClient({
    token: 't', locationId: 'l',
    fetchImpl: stubFetch([['/opportunities/search', () => ok({ opportunities: [{ name: 'Acme', monetaryValue: 5000 }] })]]),
  });
  // Groq stub: first return a tool call, then a final answer using the results.
  let turn = 0;
  const groqImpl = async () => {
    turn += 1;
    if (turn === 1) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'x', function: { name: 'ghl_list_opportunities', arguments: '{"status":"open"}' } }] } }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'You have one open deal, Acme, worth five thousand dollars, sir.' } }] }) };
  };
  const speech = await runGhlAgent('what are my open deals', { keys: ['k'], client, groqImpl });
  assert.match(speech, /Acme/);
  assert.equal(turn, 2); // one tool round + one answer
});
