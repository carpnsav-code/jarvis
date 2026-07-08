'use strict';

/**
 * Tiny static loopback server for the renderer.
 *
 * The renderer MUST be served over http, not file://: the YouTube iframe API
 * checks the `origin` param against the parent frame's origin, and a file://
 * page has a null origin, which the embed rejects with Error 153. So we serve
 * index.html + renderer.js from http://127.0.0.1 on an OS-assigned free port
 * (listen port 0), and point the BrowserWindow at that URL.
 *
 * It only serves files inside its own directory and never lists or executes
 * anything — just enough to host two static assets on loopback.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Start the server.
 *
 * @param {object} [opts]
 * @param {string} [opts.dir=__dirname]  directory whose files are served
 * @param {string} [opts.host=127.0.0.1] loopback only, by design
 * @returns {Promise<{server:http.Server, host:string, port:number, url:string, close:()=>Promise<void>}>}
 */
function startServer({ dir = __dirname, host = '127.0.0.1' } = {}) {
  const root = path.resolve(dir);

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = path.resolve(root, rel);

    // Never serve anything outside the served directory.
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const type = CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Port 0 → the OS hands us any available port.
    server.listen(0, host, () => {
      const { port } = server.address();
      resolve({
        server,
        host,
        port,
        url: `http://${host}:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

module.exports = { startServer };
