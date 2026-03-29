'use strict';

/**
 * Antigravity backend tests.
 * All requests go through the unified server (port 9000) using google/* model prefix.
 *
 * Run all:           npm test -- antigravity
 * Skip slow:         npm test -- antigravity -- -t "^(?!.*\[slow\])"
 * Only slow:         npm test -- antigravity -- -t "\[slow\]"
 * One test by name:  npm test -- antigravity -- -t "streaming"
 *
 * NOTE: These tests require the Windsurf/Antigravity IDE to be running locally.
 * They will be skipped gracefully when the backend is unavailable.
 */

const { post, get, del, streamPost } = require('./helpers/client');
const { randomDelay } = require('./helpers/delay');

afterEach(() => randomDelay(3000, 6000));

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Skip the test if the antigravity backend is not available. */
async function requireAntigravity() {
  const r = await get('/google/health');
  if (r.status !== 200 || r.body?.status !== 'ok') {
    console.warn('[antigravity tests] backend unavailable — skipping');
    return false;
  }
  return true;
}

// ── Infrastructure ─────────────────────────────────────────────────────────────

describe('infrastructure', () => {
  test('GET /health → includes antigravity backend', async () => {
    const r = await get('/health');
    expect(r.status).toBe(200);
    expect(r.body.backends).toBeTruthy();
    expect(r.body.backends.antigravity).toBeTruthy();
  });

  test('GET /v1/models → includes google/* models when available', async () => {
    const r = await get('/v1/models');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
    // If backend is up, expect google/* prefixed models
    const googleModels = r.body.data.filter(m => m.owned_by === 'antigravity');
    if (googleModels.length > 0) {
      for (const m of googleModels) {
        expect(m.id).toMatch(/^google\//);
        expect(m.label).toBeTruthy();
      }
    }
  });

  test('GET /google/health → backend-specific health endpoint', async () => {
    const r = await get('/google/health');
    expect([200, 503]).toContain(r.status);
    expect(r.body.status).toBeTruthy();
  });

  test('GET /google/sessions → returns session list', async () => {
    if (!await requireAntigravity()) return;
    const r = await get('/google/sessions');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.sessions)).toBe(true);
    expect(typeof r.body.count).toBe('number');
  });
});

// ── Basic completions ──────────────────────────────────────────────────────────

describe('completions', () => {
  test('google/gemini-flash responds to a simple prompt', async () => {
    if (!await requireAntigravity()) return;
    const r = await post('/v1/chat/completions', {
      model: 'google/gemini-flash',
      messages: [{ role: 'user', content: 'Reply with exactly one word: PONG' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.role).toBe('assistant');
    expect(r.body.choices[0].message.content.length).toBeGreaterThan(0);
    expect(r.body.choices[0].finish_reason).toBe('stop');
  });

  test('google/gemini-pro-high responds to a simple prompt', async () => {
    if (!await requireAntigravity()) return;
    const r = await post('/v1/chat/completions', {
      model: 'google/gemini-pro-high',
      messages: [{ role: 'user', content: 'Reply with exactly one word: PONG' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content.length).toBeGreaterThan(0);
  });

  test('system prompt is respected', async () => {
    if (!await requireAntigravity()) return;
    const r = await post('/v1/chat/completions', {
      model: 'google/gemini-flash',
      messages: [
        { role: 'system', content: 'You only reply with the word BANANA, nothing else.' },
        { role: 'user',   content: 'What is 1 + 1?' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content.toLowerCase()).toContain('banana');
  });

  test('unknown google model → 400 with model list', async () => {
    const r = await post('/v1/chat/completions', {
      model: 'google/nonexistent-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // Should return 400 (model unknown) regardless of IDE availability
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBeTruthy();
  });

  test('missing messages → 400', async () => {
    const r = await post('/v1/chat/completions', { model: 'google/gemini-flash' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBeTruthy();
  });
});

// ── Streaming ─────────────────────────────────────────────────────────────────

describe('streaming', () => {
  test('google/gemini-flash stream=true delivers SSE chunks', async () => {
    if (!await requireAntigravity()) return;
    const r = await streamPost('/v1/chat/completions', {
      model: 'google/gemini-flash',
      stream: true,
      messages: [{ role: 'user', content: 'Count to 3.' }],
    });
    expect(r.status).toBe(200);
    const textChunks = r.chunks.filter(c => c.event?.choices?.[0]?.delta?.content);
    expect(textChunks.length).toBeGreaterThan(0);
    const assembled = textChunks.map(c => c.event.choices[0].delta.content).join('');
    expect(assembled.length).toBeGreaterThan(0);
    expect(r.chunks.some(c => c.done)).toBe(true);
  });

  test('stream opens with role:assistant chunk', async () => {
    if (!await requireAntigravity()) return;
    const r = await streamPost('/v1/chat/completions', {
      model: 'google/gemini-flash',
      stream: true,
      messages: [{ role: 'user', content: 'Say hi.' }],
    });
    const first = r.chunks.find(c => c.event?.choices?.[0]?.delta?.role);
    expect(first).toBeTruthy();
    expect(first.event.choices[0].delta.role).toBe('assistant');
  });
});

// ── Sessions ───────────────────────────────────────────────────────────────────

describe('sessions', () => {
  test('session_id persists conversation context', async () => {
    if (!await requireAntigravity()) return;
    const sid = `test-ag-${Date.now()}`;
    await post('/v1/chat/completions', {
      model: 'google/gemini-flash', session_id: sid,
      messages: [{ role: 'user', content: 'My secret number is 42. Remember it.' }],
    });
    const r2 = await post('/v1/chat/completions', {
      model: 'google/gemini-flash', session_id: sid,
      messages: [{ role: 'user', content: 'What is my secret number?' }],
    });
    expect(r2.status).toBe(200);
    expect(r2.body.choices[0].message.content).toContain('42');
    expect(r2.body.session_id).toBe(sid);
  });

  test('DELETE /google/sessions/:id removes session', async () => {
    if (!await requireAntigravity()) return;
    const sid = `del-test-ag-${Date.now()}`;
    await post('/v1/chat/completions', {
      model: 'google/gemini-flash', session_id: sid,
      messages: [{ role: 'user', content: 'Hello.' }],
    });
    const r = await del(`/google/sessions/${sid}`);
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(sid);
  });
});

// ── [slow] Multi-turn ─────────────────────────────────────────────────────────

describe('[slow]', () => {
  test('[slow] multi-turn conversation maintains context across turns', async () => {
    if (!await requireAntigravity()) return;
    const sid = `slow-mt-${Date.now()}`;

    await post('/v1/chat/completions', {
      model: 'google/gemini-flash', session_id: sid,
      messages: [{ role: 'user', content: 'I am going to call you Bob from now on. Acknowledge with OK.' }],
    });

    await randomDelay(3000, 5000);

    const r = await post('/v1/chat/completions', {
      model: 'google/gemini-flash', session_id: sid,
      messages: [{ role: 'user', content: 'What is your name in this conversation?' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content.toLowerCase()).toContain('bob');
  });

  test('[slow] google/claude-sonnet responds to a prompt', async () => {
    if (!await requireAntigravity()) return;
    const r = await post('/v1/chat/completions', {
      model: 'google/claude-sonnet',
      messages: [{ role: 'user', content: 'What is 7 * 6? Just give the number.' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content).toContain('42');
  });
});
