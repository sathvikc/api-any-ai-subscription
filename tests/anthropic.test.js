'use strict';

/**
 * Anthropic backend tests.
 * All requests go through the unified server (port 9000) using claude/* model prefix.
 *
 * Run all:           npm test -- anthropic
 * Skip slow:         npm test -- anthropic -- -t "^(?!.*\[slow\])"
 * Only slow:         npm test -- anthropic -- -t "\[slow\]"
 * One test by name:  npm test -- anthropic -- -t "streaming"
 */

const { post, get, del, streamPost } = require('./helpers/client');
const { randomDelay } = require('./helpers/delay');
const fs = require('fs');
const path = require('path');

afterEach(() => randomDelay(3000, 6000));

// ── Infrastructure ─────────────────────────────────────────────────────────────

describe('infrastructure', () => {
  test('GET /health → anthropic backend ok', async () => {
    const r = await get('/health');
    expect(r.status).toBe(200);
    expect(r.body.backends.anthropic.status).toBe('ok');
    expect(r.body.backends.anthropic.tokenExpiresAt).toBeTruthy();
    const expiresMs = new Date(r.body.backends.anthropic.tokenExpiresAt) - Date.now();
    expect(expiresMs).toBeGreaterThan(0);
  });

  test('GET /v1/models → includes claude/* models', async () => {
    const r = await get('/v1/models');
    expect(r.status).toBe(200);
    const ids = r.body.data.map(m => m.id);
    expect(ids).toContain('claude/sonnet');
    expect(ids).toContain('claude/haiku');
    expect(ids).toContain('claude/opus');
    for (const m of r.body.data.filter(m => m.owned_by === 'anthropic')) {
      expect(m.id).toMatch(/^claude\//);
      expect(m.label).toBeTruthy();
    }
  });

  test('GET /anthropic/health → backend-specific health', async () => {
    const r = await get('/anthropic/health');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
    expect(r.body.tokenExpiresAt).toBeTruthy();
  });

  test('GET /anthropic/sessions → returns session list', async () => {
    const r = await get('/anthropic/sessions');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.sessions)).toBe(true);
    expect(typeof r.body.count).toBe('number');
  });
});

// ── Basic completions ──────────────────────────────────────────────────────────

describe('completions', () => {
  test('claude/haiku responds to a simple prompt', async () => {
    const r = await post('/v1/chat/completions', {
      model: 'claude/haiku',
      messages: [{ role: 'user', content: 'Reply with exactly one word: PONG' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.role).toBe('assistant');
    expect(r.body.choices[0].message.content.length).toBeGreaterThan(0);
    expect(r.body.choices[0].finish_reason).toBe('stop');
    expect(r.body.usage.prompt_tokens).toBeGreaterThan(0);
  });

  test('claude/sonnet responds to a simple prompt', async () => {
    const r = await post('/v1/chat/completions', {
      model: 'claude/sonnet',
      messages: [{ role: 'user', content: 'Reply with exactly one word: PONG' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content.length).toBeGreaterThan(0);
  });

  test('unknown model → 400 with model list', async () => {
    const r = await post('/v1/chat/completions', {
      model: 'claude/nonexistent',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBeTruthy();
  });

  test('missing messages → 400', async () => {
    const r = await post('/v1/chat/completions', { model: 'claude/haiku' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBeTruthy();
  });

  test('system prompt is respected', async () => {
    const r = await post('/v1/chat/completions', {
      model: 'claude/haiku',
      messages: [
        { role: 'system',  content: 'You only reply with the word BANANA, nothing else.' },
        { role: 'user',    content: 'What is 1 + 1?' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content.toLowerCase()).toContain('banana');
  });
});

// ── Streaming ─────────────────────────────────────────────────────────────────

describe('streaming', () => {
  test('claude/haiku stream=true delivers SSE chunks', async () => {
    const r = await streamPost('/v1/chat/completions', {
      model: 'claude/haiku',
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
    const r = await streamPost('/v1/chat/completions', {
      model: 'claude/haiku',
      stream: true,
      messages: [{ role: 'user', content: 'Say hi.' }],
    });
    const first = r.chunks.find(c => c.event?.choices?.[0]?.delta?.role);
    expect(first).toBeTruthy();
    expect(first.event.choices[0].delta.role).toBe('assistant');
  });
});

// ── Tool use ───────────────────────────────────────────────────────────────────

describe('tool use', () => {
  const tools = [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City name' },
        },
        required: ['location'],
      },
    },
  }];

  test('model returns tool_calls when tool is needed', async () => {
    const r = await post('/v1/chat/completions', {
      model: 'claude/haiku',
      tools,
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].finish_reason).toBe('tool_calls');
    expect(r.body.choices[0].message.tool_calls).toBeTruthy();
    const tc = r.body.choices[0].message.tool_calls[0];
    expect(tc.function.name).toBe('get_weather');
    const args = JSON.parse(tc.function.arguments);
    expect(args.location).toBeTruthy();
  });

  test('role:tool message accepted and continues conversation', async () => {
    const r1 = await post('/v1/chat/completions', {
      model: 'claude/haiku', tools,
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
    });
    expect(r1.status).toBe(200);
    const tc = r1.body.choices[0].message.tool_calls?.[0];
    if (!tc) return; // model chose not to use tool — skip

    const r2 = await post('/v1/chat/completions', {
      model: 'claude/haiku', tools,
      messages: [
        { role: 'user',      content: 'What is the weather in Paris?' },
        { role: 'assistant', content: null, tool_calls: [tc] },
        { role: 'tool',      tool_call_id: tc.id, content: '{"temperature":"18°C","condition":"sunny"}' },
      ],
    });
    expect(r2.status).toBe(200);
    expect(r2.body.choices[0].message.content).toBeTruthy();
  });

  test('tool_choice:none suppresses tool use', async () => {
    const r = await post('/v1/chat/completions', {
      model: 'claude/haiku', tools, tool_choice: 'none',
      messages: [{ role: 'user', content: 'What is the weather in Berlin?' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].finish_reason).toBe('stop');
    expect(r.body.choices[0].message.tool_calls).toBeFalsy();
  });
});

// ── Sessions ───────────────────────────────────────────────────────────────────

describe('sessions', () => {
  test('session_id persists conversation context', async () => {
    const sid = `test-${Date.now()}`;
    await post('/v1/chat/completions', {
      model: 'claude/haiku', session_id: sid,
      messages: [{ role: 'user', content: 'My secret number is 42. Remember it.' }],
    });
    const r2 = await post('/v1/chat/completions', {
      model: 'claude/haiku', session_id: sid,
      messages: [{ role: 'user', content: 'What is my secret number?' }],
    });
    expect(r2.status).toBe(200);
    expect(r2.body.choices[0].message.content).toContain('42');
    expect(r2.body.session_id).toBe(sid);
  });

  test('DELETE /anthropic/sessions/:id removes session', async () => {
    const sid = `del-test-${Date.now()}`;
    await post('/v1/chat/completions', {
      model: 'claude/haiku', session_id: sid,
      messages: [{ role: 'user', content: 'Hello.' }],
    });
    const r = await del(`/anthropic/sessions/${sid}`);
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(sid);
  });
});

// ── Vision ────────────────────────────────────────────────────────────────────

describe('vision', () => {
  const fixturePath = path.join(__dirname, 'test.png');
  const fixtureExists = fs.existsSync(fixturePath);

  test('image_url (base64) accepted in user message', async () => {
    if (!fixtureExists) return; // skip if fixture missing
    const data = fs.readFileSync(fixturePath).toString('base64');
    const r = await post('/v1/chat/completions', {
      model: 'claude/haiku',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
          { type: 'text', text: 'Describe this image in one sentence.' },
        ],
      }],
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content.length).toBeGreaterThan(0);
  });
});

// ── [slow] Agentic mode ───────────────────────────────────────────────────────

describe('[slow]', () => {
  test('agentic mode returns text response', async () => {
    const r = await post('/v1/chat/completions', {
      model:   'claude/haiku',
      mode:    'agentic',
      messages: [{ role: 'user', content: 'What is 7 * 6? Just give the number.' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content).toContain('42');
  });

  test('[slow] agentic mode streaming delivers chunks', async () => {
    const r = await streamPost('/v1/chat/completions', {
      model:   'claude/haiku',
      mode:    'agentic',
      stream:  true,
      messages: [{ role: 'user', content: 'Say the word HELLO.' }],
    });
    expect(r.status).toBe(200);
    const text = r.chunks
      .filter(c => c.event?.choices?.[0]?.delta?.content)
      .map(c => c.event.choices[0].delta.content).join('');
    expect(text.length).toBeGreaterThan(0);
  });
});
