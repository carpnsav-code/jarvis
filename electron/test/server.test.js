'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const net = require('net');
const { startServer } = require('../server');

// Send a raw request line so `..` reaches the server un-normalised (fetch and
// http.get both collapse `..` client-side before it ever leaves the process).
function rawGet(host, port, rawPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

test('server serves index.html on / over http loopback', async () => {
  const info = await startServer();
  try {
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(info.url + '/');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('Jarvis'));
  } finally {
    await info.close();
  }
});

test('server serves renderer.js with a JS content-type', async () => {
  const info = await startServer();
  try {
    const res = await fetch(info.url + '/renderer.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
  } finally {
    await info.close();
  }
});

test('server 404s unknown paths and blocks traversal', async () => {
  const info = await startServer();
  try {
    assert.equal((await fetch(info.url + '/nope.txt')).status, 404);
    // Raw request with literal `..` — exercises the guard against escaping the
    // served directory.
    const traversal = await rawGet(info.host, info.port, '/../../pyproject.toml');
    assert.match(traversal.split('\r\n')[0], /403/);
  } finally {
    await info.close();
  }
});
