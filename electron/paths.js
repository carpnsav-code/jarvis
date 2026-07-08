'use strict';

/**
 * Fixed, launch-independent storage location for persistent state.
 *
 * Deliberately NOT Electron's app.getPath('userData') / %APPDATA%: that path
 * changes depending on how the app is launched (installed vs portable vs dev,
 * different user profiles, roaming vs local), which would split memory across
 * several files and lose history. The home directory is stable across all of
 * those, so everything lives under ~/.jarvis.
 */

const os = require('os');
const path = require('path');

const JARVIS_DIR = path.join(os.homedir(), '.jarvis');

module.exports = {
  JARVIS_DIR,
  MEMORY_FILE: path.join(JARVIS_DIR, 'memory.json'),
  BACKUP_FILE: path.join(JARVIS_DIR, 'memory.backup.json'),
  MISSION_LOG: path.join(JARVIS_DIR, 'mission.log'),
};
