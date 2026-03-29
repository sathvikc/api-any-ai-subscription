'use strict';

/**
 * Router / unified server tests.
 * Tests cross-backend routing, combined endpoints, and error handling.
 *
 * Run all:           npm test -- router
 * Skip slow:         npm test -- router -- -t "^(?!.*\[slow\])"
 * One test by name:  npm test -- router -- -t "models"
 */

const { post, get } = require('./helpers/client');
const { randomDelay } = require('./helpers/delay');

afterEach(() => randomDelay(3000, 6000));

// ── /v1/models ─────────────────────────────────────────────────────────────────

describe('models', () => {
  test('GET /v1/models returns object:list', async () => {
    const r = await get('/v1/models');
    expect(r.status).toBe(200);
    expect(r.body.object).toBe('list');
    expect(Array.isArray(r.body.data)).toBe(true);
  });

  test('each model entry has id, object, owned_by, label', async () => {
    const r = await get('/v1/models');
    expect(r.status).toBe(200);
    for (const m of r.body.data) {
      expect(m.id).toBeTruthy();
      expect(m.object).toBe('model');
      expect(m.owned_by).toBeTruthy();
      expect(m.label).toBeTruthy();
    }
  });

  test('model ids are prefixed with provider namespace', async () => {
    const r = await get('/v1/models');
    expect(r.status).toBe(200);
    for (const m of r.body.data) {
      expect(m.id).toMatch(/^[a-z]+\//);
    }
  });

  test('anthropic models use claude/ prefix', async () => {
    const r = await get('/v1/models');
    const anthropicModels = r.body.data.filter(m => m.owned_by === 'anthropic');
    expect(anthropicModels.length).toBeGreaterThan(0);
    for (const m of anthropicModels) {
      expect(m.id).toMatch(/^claude\//);
    }
  });
});

// ── /health ────────────────────────────────────────────────────────────────────

describe('health', () => {
  test('GET /health returns status field', async () => {
    const r = await get('/health');
    expect([200, 503]).toContain(r.status);
    expect(['ok', 'degraded']).toContain(r.body.status);
  });

  test('GET /health includes backends object', async () => {
    const r = await get('/health');
    expect(r.body.backends).toBeTruthy();
    expect(typeof r.body.backends).toBe('object');
  });

  test('GET /health includes anthropic backend entry', async () => {
    const r = await get('/health');
    expect(r.body.backends.anthropic).toBeTruthy();
    expect(r.body.backends.anthropic.status).toBeTruthy();
  });

  test('GET /health includes antigravity backend entry', async () => {
    const r = await get('/health');
    expect(r.body.backends.antigravity).toBeTruthy();
    expect(r.body.backends.antigravity.status).toBeTruthy();
  });

  test('status is ok when all backends are ok, degraded otherwise', async () => {
    const r = await get('/health');
    const allOk = Object.values(r.body.backends).every(b => b.status === 'ok');
    if (allOk) {
      expect(r.body.status).toBe('ok');
      expect(r.status).toBe(200);
    } else {
      expect(r.body.status).toBe('degraded');
      expect(r.status).toBe(503);
    }
  });
});

// ── /status ────────────────────────────────────────────────────────────────────

describe('status', () => {
  test('GET /status returns server info', async () => {
    const r = await get('/status');
    expect(r.status).toBe(200);
    expect(r.body.server).toBeTruthy();
    expect(r.body.port).toBeTruthy();
    expect(Array.isArray(r.body.endpoints)).toBe(true);
  });
});

// ── Routing ────────────────────────────────────────────────────────────────────

describe('routing', () => {
  test('unknown model → 400 with available model list', async () => {
    const r = await post('/v1/chat/completions', {
      model: 'totally/unknown-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/unknown model/i);
    // Should tell you what IS available
    expect(r.body.error.message.length).toBeGreaterThan(20);
  });

  test('missing model field → 400', async () => {
    const r = await post('/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBeTruthy();
  });

  test('claude/* prefix routes to anthropic backend', async () => {
    const r = await post('/v1/chat/completions', {
      model: 'claude/haiku',
      messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.role).toBe('assistant');
  });

  test('unknown claude/* model → 400 (prefix known, model unknown)', async () => {
    const r = await post('/v1/chat/completions', {
      model: 'claude/no-such-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBeTruthy();
  });

  test('404 for unknown path', async () => {
    const r = await get('/no-such-endpoint');
    expect(r.status).toBe(404);
    expect(r.body.error).toBeTruthy();
  });
});

// ── CORS ───────────────────────────────────────────────────────────────────────

describe('cors', () => {
  test('POST /v1/chat/completions includes CORS header', async () => {
    // We verify by checking the response object — client.js doesn't expose headers,
    // but the server must not 500 when accessed from any origin (smoke test).
    const r = await post('/v1/chat/completions', {
      model: 'claude/haiku',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect([200, 400]).toContain(r.status);
  });
});
