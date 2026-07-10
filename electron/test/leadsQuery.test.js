'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isLeadsQuery, parseLeadsQuery, runLeadsQuery } = require('../leadsQuery');

// A stub client with a Mint pipeline and opportunities across two stages.
function stubClient() {
  const pipe = {
    id: 'PIPE',
    name: 'Mint Concrete Polishing',
    stages: [
      { id: 'st_new', name: 'New Lead' },
      { id: 'st_quote', name: 'Quote Sent' },
    ],
  };
  const opps = [
    { id: 'o1', name: 'Gina Ribaudo', pipelineStageId: 'st_new', source: 'Facebook', createdAt: '2026-07-10T02:00:00Z' },
    { id: 'o2', name: 'Barron', pipelineStageId: 'st_new', source: 'Facebook', createdAt: '2026-07-09T00:00:00Z' },
    { id: 'o3', name: 'Larry Graham', pipelineStageId: 'st_new', source: 'Facebook', createdAt: '2026-07-08T00:00:00Z' },
    { id: 'o4', name: 'Old Quote', pipelineStageId: 'st_quote', createdAt: '2026-07-01T00:00:00Z' },
  ];
  return {
    isConfigured: () => true,
    mintPipeline: async () => pipe,
    allOpportunities: async () => opps,
  };
}

test('isLeadsQuery matches lead counts / recency / stages, ignores unrelated', () => {
  assert.ok(isLeadsQuery('how many leads are in the new lead column'));
  assert.ok(isLeadsQuery('what was the most recent lead'));
  assert.ok(isLeadsQuery('give me the pipeline breakdown'));
  assert.equal(isLeadsQuery('text Harold saying hi'), false);
  assert.equal(isLeadsQuery('what time is it'), false);
});

test('parseLeadsQuery pulls intent and stage', () => {
  assert.deepEqual(parseLeadsQuery('how many leads in the new lead column'), { intent: 'count', stage: 'new lead' });
  assert.deepEqual(parseLeadsQuery('what is the most recent lead'), { intent: 'latest', stage: undefined });
  assert.equal(parseLeadsQuery('pipeline breakdown').intent, 'overview');
});

test('count reads the real New Lead stage total (not contacts)', async () => {
  const speech = await runLeadsQuery(stubClient(), { intent: 'count', stage: 'new lead' });
  assert.equal(speech, 'You have 3 leads in New Lead, sir.');
});

test('most recent lead is the newest opportunity in the stage', async () => {
  const speech = await runLeadsQuery(stubClient(), { intent: 'latest', stage: 'new lead' });
  assert.match(speech, /most recent lead in New Lead is Gina Ribaudo/);
  assert.match(speech, /from Facebook/);
});

test('latest with no stage defaults to New Lead', async () => {
  const speech = await runLeadsQuery(stubClient(), parseLeadsQuery('what was the most recent lead'));
  assert.match(speech, /Gina Ribaudo/);
});

test('overview lists every stage with its count', async () => {
  const speech = await runLeadsQuery(stubClient(), { intent: 'overview' });
  assert.match(speech, /New Lead, 3/);
  assert.match(speech, /Quote Sent, 1/);
});

test('an unknown stage name lists the real stages instead of guessing', async () => {
  const speech = await runLeadsQuery(stubClient(), { intent: 'count', stage: 'zzz nonsense' });
  assert.match(speech, /couldn't find a "zzz nonsense" stage/);
  assert.match(speech, /New Lead, Quote Sent/);
});

test('not connected is handled gracefully', async () => {
  const speech = await runLeadsQuery({ isConfigured: () => false }, { intent: 'count', stage: 'new lead' });
  assert.match(speech, /not connected/);
});
