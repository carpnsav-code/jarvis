'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseProductivityCommand,
  buildGmailComposeUrl,
  buildCalendarUrl,
  resolveProductivity,
} = require('../productivity');

test('parseProductivityCommand reads an email command', () => {
  const cmd = parseProductivityCommand('email sam@example.com about lunch tomorrow');
  assert.equal(cmd.kind, 'email');
  assert.equal(cmd.to, 'sam@example.com');
  assert.match(cmd.subject, /lunch tomorrow/);
});

test('parseProductivityCommand reads a calendar command with a time', () => {
  const cmd = parseProductivityCommand('add a calendar event dentist on Friday 3pm');
  assert.equal(cmd.kind, 'calendar');
  assert.equal(cmd.title, 'dentist');
  assert.equal(cmd.when, 'Friday 3pm');
});

test('parseProductivityCommand returns null for unrelated text', () => {
  assert.equal(parseProductivityCommand('play some music'), null);
});

test('buildGmailComposeUrl pre-fills recipient and subject', () => {
  const url = new URL(buildGmailComposeUrl({ to: 'a@b.com', subject: 'Hi there' }));
  assert.equal(url.searchParams.get('to'), 'a@b.com');
  assert.equal(url.searchParams.get('su'), 'Hi there');
  assert.equal(url.searchParams.get('view'), 'cm');
});

test('buildCalendarUrl uses the event template with the title', () => {
  const url = new URL(buildCalendarUrl({ title: 'Dentist', when: 'Friday' }));
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
  assert.equal(url.searchParams.get('text'), 'Dentist');
  assert.match(url.searchParams.get('details'), /When: Friday/);
});

test('resolveProductivity returns a url + spoken confirmation', () => {
  const email = resolveProductivity({ kind: 'email', to: 'sam@x.com', subject: 'lunch' });
  assert.match(email.url, /mail\.google\.com/);
  assert.match(email.speech, /sam@x\.com/);

  const cal = resolveProductivity({ kind: 'calendar', title: 'Standup', when: 'Monday' });
  assert.match(cal.url, /calendar\.google\.com/);
  assert.match(cal.speech, /Standup/);
});
