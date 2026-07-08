'use strict';

/**
 * Default app catalogue, seeded into `userData/apps.json` on first run.
 *
 * Two shapes live in one list:
 *   - type "app"     — a real executable we spawn directly (path + args).
 *   - type "website" — a URL we hand to a browser. We never automate *inside*
 *                      a browser window; the URL is just an argument on the
 *                      browser's command line (see computerControl.resolveLaunch).
 *
 * Every entry carries an `intent` array: the natural phrases a person might
 * actually say ("browse the web", "look something up"). The router matches a
 * spoken/AI target against these, so adding a new way to ask for an app is a
 * one-line change here — no code.
 *
 * Executable paths are platform-specific, so the defaults are chosen per
 * `process.platform`. A path that doesn't exist on this machine is not fatal:
 * the launcher runs existsSync() before every spawn and returns a readable
 * error, so a bad default degrades to "I couldn't find Chrome" rather than a
 * crash. Users are expected to edit apps.json to match their machine.
 */

// The id of the app used to open websites. Kept in one place so every website
// entry can default to it without repeating the path.
const DEFAULT_BROWSER_ID = 'browser';

// Personal handle used by deep links that target the user's own page (e.g.
// Instagram). It ships as an obvious placeholder — edit it in apps.json (or the
// line below) to your real handle. Until then, "open Instagram" lands on the
// login/handle page rather than a broken URL.
const INSTAGRAM_HANDLE = 'your_handle';

// Websites are platform-independent — the same list rides on top of whatever
// browser the platform section defines.
const WEBSITES = [
  {
    id: 'web_search',
    name: 'Web search',
    type: 'website',
    url: 'https://www.google.com',
    intent: [
      'browse the web', 'browse web', 'go online', 'search the web',
      'search online', 'look something up', 'google something', 'the internet',
      'get online',
    ],
  },
  {
    id: 'youtube',
    name: 'YouTube',
    type: 'website',
    url: 'https://www.youtube.com',
    intent: ['youtube', 'open youtube', 'watch videos', 'watch a video'],
  },
  {
    id: 'gmail',
    name: 'Gmail',
    type: 'website',
    url: 'https://mail.google.com',
    intent: ['gmail', 'open gmail', 'check my email', 'check email', 'my email'],
  },
  {
    id: 'maps',
    name: 'Google Maps',
    type: 'website',
    url: 'https://maps.google.com',
    intent: ['maps', 'google maps', 'open maps', 'directions'],
  },

  // --- Deep links -------------------------------------------------------------
  // URLs that jump straight to an action, not just a home page. "new Google Doc"
  // creates a blank document rather than opening the Docs landing page.
  {
    id: 'new_google_doc',
    name: 'new Google Doc',
    type: 'website',
    url: 'https://docs.google.com/document/create',
    intent: [
      'new google doc', 'new doc', 'create a doc', 'create a document',
      'start a document', 'new document', 'blank doc',
    ],
  },
  {
    id: 'new_google_sheet',
    name: 'new Google Sheet',
    type: 'website',
    url: 'https://docs.google.com/spreadsheets/create',
    intent: [
      'new google sheet', 'new sheet', 'new spreadsheet', 'create a spreadsheet',
      'start a spreadsheet', 'blank spreadsheet',
    ],
  },
  {
    id: 'new_google_slides',
    name: 'new Google Slides',
    type: 'website',
    url: 'https://docs.google.com/presentation/create',
    intent: [
      'new google slides', 'new slides', 'new presentation',
      'create a presentation', 'start a presentation', 'new slide deck',
    ],
  },
  {
    id: 'compose_email',
    name: 'new email',
    type: 'website',
    url: 'https://mail.google.com/mail/?view=cm&fs=1',
    intent: [
      'new email', 'compose email', 'compose an email', 'write an email',
      'send an email', 'draft an email',
    ],
  },
  {
    id: 'instagram',
    name: 'Instagram',
    type: 'website',
    url: `https://www.instagram.com/${INSTAGRAM_HANDLE}`,
    intent: ['instagram', 'open instagram', 'my instagram', 'insta', 'ig'],
  },
];

// Per-platform executables. Keys are process.platform values.
const NATIVE = {
  darwin: [
    {
      id: 'browser',
      name: 'Google Chrome',
      type: 'app',
      path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: [],
      intent: ['browser', 'chrome', 'open the browser', 'open chrome', 'web browser'],
    },
    {
      id: 'terminal',
      name: 'Terminal',
      type: 'app',
      path: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
      args: [],
      intent: ['terminal', 'open terminal', 'command line', 'shell', 'console'],
    },
    {
      id: 'calculator',
      name: 'Calculator',
      type: 'app',
      path: '/System/Applications/Calculator.app/Contents/MacOS/Calculator',
      args: [],
      intent: ['calculator', 'open calculator', 'calc', 'do some math'],
    },
    {
      id: 'notes',
      name: 'Notes',
      type: 'app',
      path: '/System/Applications/Notes.app/Contents/MacOS/Notes',
      args: [],
      intent: ['notes', 'open notes', 'take a note', 'notepad'],
    },
  ],
  win32: [
    {
      id: 'browser',
      name: 'Google Chrome',
      type: 'app',
      path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: [],
      intent: ['browser', 'chrome', 'open the browser', 'open chrome', 'web browser'],
    },
    {
      id: 'terminal',
      name: 'Command Prompt',
      type: 'app',
      path: 'C:\\Windows\\System32\\cmd.exe',
      args: [],
      intent: ['terminal', 'command prompt', 'command line', 'shell', 'console', 'cmd'],
    },
    {
      id: 'calculator',
      name: 'Calculator',
      type: 'app',
      path: 'C:\\Windows\\System32\\calc.exe',
      args: [],
      intent: ['calculator', 'open calculator', 'calc', 'do some math'],
    },
    {
      id: 'notepad',
      name: 'Notepad',
      type: 'app',
      path: 'C:\\Windows\\System32\\notepad.exe',
      args: [],
      intent: ['notepad', 'open notepad', 'take a note', 'notes', 'text editor'],
    },
    {
      id: 'explorer',
      name: 'File Explorer',
      type: 'app',
      path: 'C:\\Windows\\explorer.exe',
      args: [],
      intent: ['files', 'file explorer', 'open files', 'my files', 'finder'],
    },
  ],
  linux: [
    {
      id: 'browser',
      name: 'Google Chrome',
      type: 'app',
      path: '/usr/bin/google-chrome',
      args: [],
      intent: ['browser', 'chrome', 'open the browser', 'open chrome', 'web browser'],
    },
    {
      id: 'terminal',
      name: 'Terminal',
      type: 'app',
      path: '/usr/bin/gnome-terminal',
      args: [],
      intent: ['terminal', 'open terminal', 'command line', 'shell', 'console'],
    },
    {
      id: 'calculator',
      name: 'Calculator',
      type: 'app',
      path: '/usr/bin/gnome-calculator',
      args: [],
      intent: ['calculator', 'open calculator', 'calc', 'do some math'],
    },
    {
      id: 'files',
      name: 'Files',
      type: 'app',
      path: '/usr/bin/nautilus',
      args: [],
      intent: ['files', 'file manager', 'open files', 'my files', 'finder', 'explorer'],
    },
  ],
};

/**
 * The default app list for a platform: its native executables plus the shared
 * website shortcuts. Unknown platforms fall back to the Linux set, which is the
 * most permissive (plain /usr/bin paths).
 *
 * @param {NodeJS.Platform} [platform=process.platform]
 * @returns {Array<object>} deep-ish copy safe for the caller to mutate/persist
 */
function defaultApps(platform = process.platform) {
  const native = NATIVE[platform] || NATIVE.linux;
  const websites = WEBSITES.map((w) => ({ ...w, browser: DEFAULT_BROWSER_ID }));
  // Fresh objects so the returned catalogue can be serialized/edited without
  // mutating the module-level templates.
  return [...native.map((a) => ({ ...a })), ...websites];
}

module.exports = { defaultApps, DEFAULT_BROWSER_ID };
