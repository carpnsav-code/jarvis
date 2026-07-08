'use strict';

/**
 * Behavior tests for computer control. No Electron, no real spawns: the
 * side-effecting deps (existsSync, spawn, fs) are injected, so these run under
 * plain `node --test`.
 *
 * Like tests/test_signoff.py on the Python side, this file is the record of
 * what the router is pinned to. A new real-world phrase that should match an app
 * goes in here as a case.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const {
  canonIntent,
  normalise,
  matchApp,
  resolveLaunch,
  launchApp,
  loadApps,
  handleCommand,
} = require('../computerControl');
const { defaultApps } = require('../defaultApps');

// A fake spawn that records the call and returns a child-like object whose
// unref() we can assert was invoked.
function fakeSpawn(record) {
  return (execPath, args, options) => {
    let unreffed = false;
    record.push({ execPath, args, options });
    return {
      pid: 4242,
      unref() {
        unreffed = true;
        record.unreffed = unreffed;
      },
    };
  };
}

test('canonIntent collapses every launch variant to one action', () => {
  for (const phrase of [
    'open app', 'launch application', 'run program', 'start app',
    'open the app', 'OPEN APPLICATION', 'launch', 'run', 'start', 'open',
  ]) {
    const { action, canonical } = canonIntent(phrase);
    assert.equal(action, 'launch', `"${phrase}" should map to launch`);
    assert.equal(canonical, true, `"${phrase}" should be a known alias`);
  }
});

test('canonIntent never silently drops an unknown verb — it defaults to launch', () => {
  const { action, canonical } = canonIntent('yeet the calculator onto my screen');
  assert.equal(action, 'launch');
  assert.equal(canonical, false); // fell back, but did not drop
});

test('canonIntent hands non-launch verbs off instead of guessing launch', () => {
  for (const phrase of ['close the window', 'mute', 'take a screenshot']) {
    assert.equal(canonIntent(phrase).action, 'unknown', phrase);
  }
});

test('canonIntent finds a launch verb inside a longer phrase', () => {
  assert.equal(canonIntent('please open the app for me').action, 'launch');
});

test('normalise strips punctuation and case', () => {
  assert.equal(normalise('  Open   CHROME! '), 'open chrome');
});

test('matchApp resolves ids, intent phrases, and natural language', () => {
  const apps = defaultApps('linux');
  assert.equal(matchApp(apps, 'browser').id, 'browser');
  assert.equal(matchApp(apps, 'browse the web').id, 'web_search');
  assert.equal(matchApp(apps, 'open youtube please').id, 'youtube');
  assert.equal(matchApp(apps, 'do some math').id, 'calculator');
  assert.equal(matchApp(apps, 'nothing like this exists'), null);
});

test('deep-link phrases match their apps', () => {
  const apps = defaultApps('linux');
  assert.equal(matchApp(apps, 'new google doc').id, 'new_google_doc');
  assert.equal(matchApp(apps, 'create a spreadsheet').id, 'new_google_sheet');
  assert.equal(matchApp(apps, 'open instagram').id, 'instagram');
  assert.equal(matchApp(apps, 'compose an email').id, 'compose_email');
});

test('resolveLaunch opens a website by passing the URL as a browser argument', () => {
  const apps = defaultApps('linux');
  const doc = apps.find((a) => a.id === 'new_google_doc');
  const launch = resolveLaunch(doc, apps);
  assert.equal(launch.path, '/usr/bin/google-chrome'); // the browser executable
  assert.deepEqual(launch.args, ['https://docs.google.com/document/create']);
});

test('resolveLaunch returns an app path and args directly', () => {
  const apps = defaultApps('linux');
  const calc = apps.find((a) => a.id === 'calculator');
  const launch = resolveLaunch(calc, apps);
  assert.equal(launch.path, '/usr/bin/gnome-calculator');
  assert.deepEqual(launch.args, []);
});

test('launchApp returns a readable error when the executable is missing', () => {
  const record = [];
  const result = launchApp(
    { path: '/nope/not-here', describe: 'Chrome' },
    { existsImpl: () => false, spawnImpl: fakeSpawn(record) },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /couldn't find Chrome/i);
  assert.equal(record.length, 0, 'must not spawn when the path is missing');
});

test('launchApp spawns detached and unrefs so the app outlives us', () => {
  const record = [];
  const result = launchApp(
    { path: '/usr/bin/google-chrome', args: ['https://x.test'], describe: 'Chrome' },
    { existsImpl: () => true, spawnImpl: fakeSpawn(record) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.pid, 4242);
  assert.equal(record[0].options.detached, true);
  assert.equal(record[0].options.stdio, 'ignore');
  assert.equal(record.unreffed, true, 'child.unref() must be called');
});

test('handleCommand runs end to end for an app', () => {
  const record = [];
  const apps = defaultApps('linux');
  const res = handleCommand(
    { action: 'open app', target: 'calculator' },
    { apps, existsImpl: () => true, spawnImpl: fakeSpawn(record) },
  );
  assert.equal(res.ok, true);
  assert.equal(res.app, 'calculator');
  assert.equal(record[0].execPath, '/usr/bin/gnome-calculator');
});

test('handleCommand opens a website via the browser', () => {
  const record = [];
  const apps = defaultApps('linux');
  const res = handleCommand(
    { action: 'browse the web', target: 'browse the web' },
    { apps, existsImpl: () => true, spawnImpl: fakeSpawn(record) },
  );
  assert.equal(res.ok, true);
  assert.equal(res.app, 'web_search');
  assert.equal(record[0].execPath, '/usr/bin/google-chrome');
  assert.deepEqual(record[0].args, ['https://www.google.com']);
});

test('handleCommand reports an unknown target instead of dropping it', () => {
  const apps = defaultApps('linux');
  const res = handleCommand(
    { action: 'open app', target: 'quantum flux capacitor' },
    { apps, existsImpl: () => true, spawnImpl: fakeSpawn([]) },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /don't know how to open/i);
});

test('handleCommand refuses a non-launch verb with a spoken reason', () => {
  const apps = defaultApps('linux');
  const res = handleCommand(
    { action: 'close', target: 'calculator' },
    { apps, existsImpl: () => true, spawnImpl: fakeSpawn([]) },
  );
  assert.equal(res.ok, false);
  assert.equal(res.action, 'unknown');
});

test('loadApps seeds defaults on first run and does not clobber edits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-apps-'));
  const appsPath = path.join(dir, 'sub', 'apps.json');

  // First run: file absent -> seeded and written.
  const seeded = loadApps(appsPath, { platform: 'linux' });
  assert.ok(seeded.length > 0);
  assert.ok(fs.existsSync(appsPath), 'apps.json should be created');

  // User edits the file.
  const edited = [{ id: 'mine', name: 'Mine', type: 'app', path: '/bin/true', intent: ['mine'] }];
  fs.writeFileSync(appsPath, JSON.stringify(edited), 'utf8');

  // Second run: existing file is respected, not re-seeded.
  const reloaded = loadApps(appsPath, { platform: 'linux' });
  assert.deepEqual(reloaded, edited);

  fs.rmSync(dir, { recursive: true, force: true });
});
