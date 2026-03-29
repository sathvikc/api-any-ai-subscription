'use strict';

/**
 * Lightweight HTTP client for integration tests.
 * All calls go to the unified server (default port 9000).
 * Override with TEST_PORT env var.
 */

const http = require('http');

const PORT = parseInt(process.env.TEST_PORT ?? '9000');

function post(path, body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', d => data += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data), raw: data }); }
          catch { resolve({ status: res.statusCode, body: null, raw: data }); }
        });
      }
    );
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT, path, method: 'GET' },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', d => data += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data), raw: data }); }
          catch { resolve({ status: res.statusCode, body: null, raw: data }); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function del(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT, path, method: 'DELETE' },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', d => data += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data), raw: data }); }
          catch { resolve({ status: res.statusCode, body: null, raw: data }); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function streamPost(path, body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } },
      (res) => {
        const chunks = [];
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', d => {
          buf += d;
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            if (line === 'data: [DONE]') { chunks.push({ done: true }); continue; }
            if (line.startsWith('data: ')) {
              try { chunks.push({ event: JSON.parse(line.slice(6)) }); } catch {}
            }
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, chunks }));
      }
    );
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

module.exports = { PORT, post, get, del, streamPost };
