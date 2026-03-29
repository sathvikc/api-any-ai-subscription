'use strict';

/**
 * Unified OpenAI-compatible HTTP server — single port, multiple backends.
 *
 * Endpoints:
 *   POST /v1/chat/completions   — routed by model prefix (claude/* → anthropic, google/* → antigravity)
 *   GET  /v1/models             — combined model list from all backends
 *   GET  /health                — aggregate health from all backends
 *   GET  /status                — server info
 *   ANY  /anthropic/*           — anthropic backend admin (sessions, quota, workers)
 *   ANY  /google/*              — antigravity backend admin (sessions, quota, probe)
 */

const http   = require('http');
const router = require('./router');

// Register backends
router.register(require('./backends/anthropic'));
router.register(require('./backends/antigravity'));

const PORT = parseInt(process.env.PORT ?? '9000');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResp(res, status, data) {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

function errBody(msg) {
  return { error: { message: String(msg), type: 'invalid_request_error', code: null } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ─── Request handler ──────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url  = req.url.split('?')[0];
  const method = req.method;

  // ── POST /v1/chat/completions ───────────────────────────────────────────────
  if (method === 'POST' && url === '/v1/chat/completions') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return jsonResp(res, 400, errBody(e.message)); }
    return router.route(body, res);
  }

  // ── GET /v1/models ──────────────────────────────────────────────────────────
  if (method === 'GET' && url === '/v1/models') {
    const data = await router.listModels();
    return jsonResp(res, 200, data);
  }

  // ── GET /health ─────────────────────────────────────────────────────────────
  if (method === 'GET' && url === '/health') {
    const data   = await router.healthAll();
    const status = data.status === 'ok' ? 200 : 503;
    return jsonResp(res, status, data);
  }

  // ── GET /status ─────────────────────────────────────────────────────────────
  if (method === 'GET' && url === '/status') {
    return jsonResp(res, 200, {
      server:    'OpenRouter-style local AI bridge',
      port:      PORT,
      endpoints: [
        'POST /v1/chat/completions',
        'GET  /v1/models',
        'GET  /health',
        'GET  /status',
        'ANY  /anthropic/*  — anthropic backend admin',
        'ANY  /google/*     — antigravity backend admin',
      ],
    });
  }

  // ── Backend admin routes (/anthropic/*, /google/*) ──────────────────────────
  // URL format: /<backendPrefix>/<adminPath>
  // e.g. GET /anthropic/sessions  →  anthropic.handleAdminRequest('/sessions', 'GET', ...)
  //      GET /google/quota        →  antigravity.handleAdminRequest('/quota', 'GET', ...)
  const adminMatch = url.match(/^\/(anthropic|google)(\/.*)?$/);
  if (adminMatch) {
    const backendId  = adminMatch[1] === 'google' ? 'antigravity' : 'anthropic';
    const adminPath  = adminMatch[2] || '/';
    let body = {};
    try { body = await readBody(req); } catch (_) {}
    return router.routeAdmin(backendId, adminPath, method, body, res);
  }

  // ── 404 ─────────────────────────────────────────────────────────────────────
  jsonResp(res, 404, errBody('Not found. GET /status for available endpoints.'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

router.init().then(() => {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
    console.log(`[server] Routes: claude/* → anthropic, google/* → antigravity`);
  });
}).catch(err => {
  console.error(`[server] Failed to initialise: ${err.message}`);
  process.exit(1);
});

process.on('uncaughtException',  e => console.error('[server] uncaughtException:', e.message));
process.on('unhandledRejection', e => console.error('[server] unhandledRejection:', e));
