'use strict';

/**
 * Computer control for the Jarvis Electron main process.
 *
 * The assistant decides *what* the user wants; this module decides *how* to make
 * it happen on the machine. It owns three jobs:
 *
 *   1. Catalogue  — load/seed the user's app definitions (userData/apps.json).
 *   2. Understand — turn a loosely-phrased AI command into a concrete app.
 *   3. Launch     — spawn that app detached so it outlives the assistant.
 *
 * Two design rules, both defensive, both matching the rest of Jarvis:
 *
 *   - Never silently drop a command. Models phrase the same intent a dozen ways
 *     ("open app", "launch application", "run the program"). canonIntent()
 *     collapses every launch-like variant to ONE internal action string, so the
 *     router acts on it instead of failing to recognise it and going quiet.
 *
 *   - Never crash on a bad path. Every spawn is preceded by existsSync(), so a
 *     missing executable becomes a readable "I couldn't find X" result the
 *     assistant can speak — not an uncaught exception that takes down the app.
 *
 * The side-effecting bits (spawn, existsSync, fs) are injectable so the logic is
 * unit-testable without launching real programs; see test/computerControl.test.js.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { defaultApps, DEFAULT_BROWSER_ID } = require('./defaultApps');

// --- Internal actions -----------------------------------------------------------
//
// There is really only one thing this module does — put something in front of
// the user — so there is exactly one internal action. canonIntent() is the
// funnel every AI-returned verb passes through to reach it.
const ACTIONS = Object.freeze({
  LAUNCH: 'launch',
  UNKNOWN: 'unknown',
});

// Known verb variants a model might emit for "make this appear on screen".
// Anything launch-shaped maps to LAUNCH; the map is just documentation +
// a fast path. The real guarantee is the fallback in canonIntent().
const INTENT_ALIASES = new Map(
  [
    'launch', 'launch app', 'launch application', 'launch program',
    'open', 'open app', 'open application', 'open program', 'open the app',
    'run', 'run app', 'run application', 'run program',
    'start', 'start app', 'start application', 'start program',
    'open website', 'open url', 'open site', 'browse', 'browse to', 'go to',
    'navigate', 'navigate to', 'visit', 'show', 'bring up', 'pull up',
  ].map((k) => [k, ACTIONS.LAUNCH]),
);

// Verbs that clearly are NOT this module's job. Kept small and explicit so the
// launch fallback below can stay aggressive without swallowing, say, a request
// to change the volume.
const NON_LAUNCH_VERBS = new Set([
  'close', 'quit', 'kill', 'stop', 'exit',
  'mute', 'unmute', 'volume', 'pause', 'play', 'skip',
  'type', 'click', 'scroll', 'screenshot',
]);

/**
 * Normalise text for matching: lowercase, strip punctuation, collapse
 * whitespace. "Open Chrome!" and "open   chrome" become the same key.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalise(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Collapse any AI-returned action variant to one internal action string.
 *
 * This is the promise that the router never silently drops a command: a known
 * alias resolves directly, and — crucially — an *unknown* verb still resolves
 * to LAUNCH rather than to null, because in this assistant an unrecognised verb
 * paired with a target is overwhelmingly "please open this". The only things
 * that do NOT become LAUNCH are the explicitly non-launch verbs above.
 *
 * @param {unknown} rawAction
 * @returns {{ action: string, canonical: boolean }}
 *   `canonical` is false when we had to fall back, so callers can log the guess
 *   instead of it being invisible.
 */
function canonIntent(rawAction) {
  const key = normalise(rawAction);

  if (INTENT_ALIASES.has(key)) {
    return { action: INTENT_ALIASES.get(key), canonical: true };
  }

  // Word-level check: if any token is a known non-launch verb, hand it off.
  const tokens = key ? key.split(' ') : [];
  if (tokens.some((t) => NON_LAUNCH_VERBS.has(t))) {
    return { action: ACTIONS.UNKNOWN, canonical: true };
  }

  // Word-level check for launch verbs embedded in a longer phrase
  // ("please launch the app for me").
  if (tokens.some((t) => INTENT_ALIASES.has(t))) {
    return { action: ACTIONS.LAUNCH, canonical: true };
  }

  // Fallback: treat it as a launch anyway. Better to try to open the target
  // and possibly report "couldn't find it" than to drop the command in silence.
  return { action: ACTIONS.LAUNCH, canonical: false };
}

/**
 * Load the app catalogue from disk, seeding defaults on first run.
 *
 * The seed is written atomically-ish (write full file) only when apps.json is
 * missing, so a user's edits are never clobbered. A corrupt/unreadable file is
 * reported to the caller rather than silently overwritten.
 *
 * @param {string} appsPath  absolute path to apps.json (…/userData/apps.json)
 * @param {object} [deps]
 * @param {typeof fs} [deps.fsImpl]
 * @param {NodeJS.Platform} [deps.platform]
 * @returns {Array<object>} the app definitions
 */
function loadApps(appsPath, { fsImpl = fs, platform = process.platform } = {}) {
  if (!fsImpl.existsSync(appsPath)) {
    const seeded = defaultApps(platform);
    fsImpl.mkdirSync(path.dirname(appsPath), { recursive: true });
    fsImpl.writeFileSync(appsPath, JSON.stringify(seeded, null, 2), 'utf8');
    return seeded;
  }

  const raw = fsImpl.readFileSync(appsPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`apps.json is not a JSON array: ${appsPath}`);
  }
  return parsed;
}

/**
 * Find the app whose intent phrases best match a target string.
 *
 * Matching is deliberately forgiving but ordered strongest-first so a precise
 * ask wins over a fuzzy one:
 *   1. exact id match            ("browser")
 *   2. exact intent-phrase match ("browse the web")
 *   3. phrase containment either way ("open youtube please" ⊃ "youtube")
 *   4. token overlap             (shares a meaningful word)
 *
 * @param {Array<object>} apps
 * @param {unknown} target
 * @returns {object|null} the matched app, or null if nothing is close enough
 */
function matchApp(apps, target) {
  const q = normalise(target);
  if (!q) return null;

  const qTokens = new Set(q.split(' '));

  let best = null;
  let bestScore = 0;

  for (const app of apps) {
    const id = normalise(app.id);
    const name = normalise(app.name);
    const phrases = [id, name, ...(Array.isArray(app.intent) ? app.intent : [])]
      .map(normalise)
      .filter(Boolean);

    let score = 0;
    for (const phrase of phrases) {
      if (!phrase) continue;
      if (phrase === q) {
        score = Math.max(score, 100);
      } else if (q.includes(phrase) || phrase.includes(q)) {
        // Longer overlaps are more specific — weight by matched length.
        score = Math.max(score, 50 + Math.min(phrase.length, q.length));
      } else {
        const shared = phrase.split(' ').filter((t) => qTokens.has(t)).length;
        if (shared > 0) score = Math.max(score, 10 * shared);
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = app;
    }
  }

  return best;
}

/**
 * Resolve an app definition into the concrete { path, args } to spawn.
 *
 * For a plain app it's just its path/args. For a website we DON'T automate a
 * browser window — we spawn the browser executable with the URL as a trailing
 * command-line argument, which is the robust, driver-free way to open a page.
 *
 * @param {object} app     the matched definition
 * @param {Array<object>} apps  full catalogue (to resolve a website's browser)
 * @returns {{ path: string, args: string[], describe: string }}
 * @throws {Error} if a website references a browser that isn't in the catalogue
 */
function resolveLaunch(app, apps) {
  if (app.type === 'website') {
    const browserId = app.browser || DEFAULT_BROWSER_ID;
    const browser = apps.find((a) => a.id === browserId);
    if (!browser) {
      throw new Error(
        `"${app.name}" needs the "${browserId}" browser, which isn't configured.`,
      );
    }
    const args = [...(browser.args || []), app.url];
    return { path: browser.path, args, describe: `${app.name} (via ${browser.name})` };
  }

  return {
    path: app.path,
    args: [...(app.args || [])],
    describe: app.name || app.id || app.path,
  };
}

/**
 * Spawn a program detached so it survives the assistant closing.
 *
 * The existsSync() guard is the whole point: a missing executable returns a
 * readable error instead of letting spawn throw ENOENT (which, for a detached
 * process, surfaces asynchronously and is easy to miss). On success we detach
 * from stdio and unref() so this process's event loop isn't held open by the
 * child.
 *
 * @param {{ path: string, args?: string[], describe?: string }} launch
 * @param {object} [deps]
 * @param {typeof fs.existsSync} [deps.existsImpl]
 * @param {typeof spawn} [deps.spawnImpl]
 * @returns {{ ok: true, pid: number, path: string, describe: string }
 *          | { ok: false, error: string, path: string }}
 */
function launchApp(launch, { existsImpl = fs.existsSync, spawnImpl = spawn } = {}) {
  const { path: execPath, args = [], describe = execPath } = launch || {};

  if (!execPath) {
    return { ok: false, error: 'No executable path to launch.', path: '' };
  }

  if (!existsImpl(execPath)) {
    return {
      ok: false,
      error: `I couldn't find ${describe} at "${execPath}". Check the path in apps.json.`,
      path: execPath,
    };
  }

  try {
    const child = spawnImpl(execPath, args, {
      detached: true,   // its own process group — outlives us
      stdio: 'ignore',  // don't tie the child to our streams
    });
    // Let the child run free; don't keep our event loop alive waiting on it.
    child.unref();
    return { ok: true, pid: child.pid, path: execPath, describe };
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't launch ${describe}: ${err.message}`,
      path: execPath,
    };
  }
}

/**
 * The router: one AI command in, one result out.
 *
 * Shape of an AI command: { action?: string, target?: string }. `action` is the
 * verb ("open app"); `target` is what to open ("chrome" / "browse the web").
 * Every path returns a structured result the assistant can turn into speech —
 * there is no branch that returns undefined.
 *
 * @param {{ action?: string, target?: string }} command
 * @param {object} deps
 * @param {Array<object>} deps.apps    the catalogue (from loadApps)
 * @param {typeof fs.existsSync} [deps.existsImpl]
 * @param {typeof spawn} [deps.spawnImpl]
 * @returns {object} { ok, action, ... }
 */
function handleCommand(command, { apps, existsImpl, spawnImpl } = {}) {
  const cmd = command || {};
  const { action, canonical } = canonIntent(cmd.action);

  if (action !== ACTIONS.LAUNCH) {
    return {
      ok: false,
      action,
      error: `I don't handle "${cmd.action}" yet — I can only open apps and websites.`,
    };
  }

  if (!Array.isArray(apps)) {
    return { ok: false, action, error: 'No app catalogue is loaded.' };
  }

  const app = matchApp(apps, cmd.target);
  if (!app) {
    return {
      ok: false,
      action,
      canonicalIntent: canonical,
      error: `I don't know how to open "${cmd.target}". Add it to apps.json.`,
    };
  }

  let launch;
  try {
    launch = resolveLaunch(app, apps);
  } catch (err) {
    return { ok: false, action, app: app.id, error: err.message };
  }

  const result = launchApp(launch, { existsImpl, spawnImpl });
  return { ok: result.ok, action, app: app.id, canonicalIntent: canonical, ...result };
}

module.exports = {
  ACTIONS,
  normalise,
  canonIntent,
  loadApps,
  matchApp,
  resolveLaunch,
  launchApp,
  handleCommand,
};
