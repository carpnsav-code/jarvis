'use strict';

/**
 * Self-signed TLS cert so phones can reach Jarvis over https (browsers require a
 * secure context for microphone access, and http://<lan-ip> isn't one).
 *
 * Generated once with the system openssl into ~/.jarvis and reused. If openssl
 * isn't available we return null and the server runs http-only (desktop still
 * works via localhost, which counts as secure).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { JARVIS_DIR } = require('./paths');

const KEY_PATH = path.join(JARVIS_DIR, 'key.pem');
const CERT_PATH = path.join(JARVIS_DIR, 'cert.pem');

/**
 * @param {string|null} ip  LAN IP to include in the cert's SAN
 * @returns {{key: Buffer, cert: Buffer}|null}
 */
function ensureCert(ip) {
  try {
    if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
      return { key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH) };
    }
  } catch {
    /* fall through to generate */
  }
  try {
    fs.mkdirSync(JARVIS_DIR, { recursive: true });
    const san = `subjectAltName=DNS:localhost,IP:127.0.0.1${ip ? `,IP:${ip}` : ''}`;
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', KEY_PATH, '-out', CERT_PATH, '-days', '825', '-subj', '/CN=jarvis', '-addext', san],
      { stdio: 'ignore' },
    );
    return { key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH) };
  } catch {
    return null; // openssl missing → http-only
  }
}

module.exports = { ensureCert };
