'use strict';

/**
 * Anthropic backend driver.
 * Calls api.anthropic.com using the OAuth token stored in the macOS Keychain.
 * Supports direct API mode and agentic subprocess mode (claude -p).
 *
 * Interface: { id, prefix, init, models, health, complete, handleAdminRequest }
 */

const https   = require('https');
const fs      = require('fs');
const { execSync, spawn } = require('child_process');
const readline = require('readline');

const API_HOST         = 'api.anthropic.com';
const CLAUDE_CODE_SYS  = "You are Claude Code, Anthropic's official CLI for Claude.";
const BETA_HEADERS     = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[anthropic] ${new Date().toISOString().slice(11, 23)} ${msg}`);
}

function jsonResp(res, status, data) {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

function errBody(msg) {
  return { error: { message: String(msg), type: 'invalid_request_error', code: null } };
}

function httpsReq(host, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method, headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ body: data, statusCode: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Token management ─────────────────────────────────────────────────────────

let cachedCreds = null;

function loadToken() {
  try {
    const username = require('os').userInfo().username;
    const raw = execSync(
      `security find-generic-password -s "Claude Code-credentials" -a ${username} -w`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    cachedCreds = JSON.parse(raw);
    const oauth = cachedCreds.claudeAiOauth;
    if (oauth) {
      const expiresIn = Math.round((oauth.expiresAt - Date.now()) / 60000);
      if (expiresIn < 0) {
        log(`Token EXPIRED ${-expiresIn}m ago — refreshing...`);
        refreshToken();
      } else {
        log(`Token loaded — expires in ${expiresIn}m, tier: ${oauth.rateLimitTier}`);
      }
      return oauth.accessToken;
    }
  } catch (err) {
    log(`ERROR: Could not read keychain: ${err.message}`);
  }
  return null;
}

async function refreshToken() {
  try {
    const oauth = cachedCreds?.claudeAiOauth;
    if (!oauth?.refreshToken) { log('Refresh skipped — no refresh token available'); return; }
    const body = JSON.stringify({
      grant_type:    'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id:     '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    });
    const res = await httpsReq('platform.claude.com', 'POST', '/v1/oauth/token', {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    }, body);
    if (res.statusCode !== 200) { log(`Token refresh failed — HTTP ${res.statusCode}: ${res.body}`); return; }
    const data = JSON.parse(res.body);
    oauth.accessToken  = data.access_token;
    oauth.refreshToken = data.refresh_token;
    oauth.expiresAt    = Date.now() + data.expires_in * 1000;
    const username = require('os').userInfo().username;
    const updated  = JSON.stringify(cachedCreds).replace(/'/g, "'\\''");
    execSync(
      `security add-generic-password -U -s "Claude Code-credentials" -a ${username} -w '${updated}'`,
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    log(`Token refreshed — new expiry in ${Math.round(data.expires_in / 60)}m`);
  } catch (err) {
    log(`ERROR: Token refresh failed: ${err.message}`);
  }
}

function getToken() {
  if (!cachedCreds) loadToken();
  return cachedCreds?.claudeAiOauth?.accessToken || null;
}

// ─── Model registry ───────────────────────────────────────────────────────────

const MODELS = {
  'haiku':  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5'  },
  'sonnet': { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6' },
  'opus':   { id: 'claude-opus-4-6',           label: 'Claude Opus 4.6'   },
};
const DEFAULT_MODEL = 'sonnet';

function resolveModel(requested) {
  const key = (requested || DEFAULT_MODEL).toLowerCase();
  if (MODELS[key]) return { alias: key, ...MODELS[key] };
  const entry = Object.entries(MODELS).find(([, m]) => m.id === key);
  return entry ? { alias: entry[0], ...entry[1] } : { alias: DEFAULT_MODEL, ...MODELS[DEFAULT_MODEL] };
}

// ─── Rate limit tracker ───────────────────────────────────────────────────────

const rateLimitStats = {};

function updateRateLimits(modelAlias, headers) {
  const util5h  = parseFloat(headers['anthropic-ratelimit-unified-5h-utilization'] ?? NaN);
  const util7d  = parseFloat(headers['anthropic-ratelimit-unified-7d-utilization'] ?? NaN);
  const reset5h = headers['anthropic-ratelimit-unified-5h-reset'] ?? null;
  if (!isNaN(util5h)) {
    rateLimitStats[modelAlias] = {
      util5h,
      util7d:    isNaN(util7d) ? null : util7d,
      resetAt5h: reset5h ? new Date(parseInt(reset5h) * 1000).toISOString() : null,
      lastSeen:  new Date().toISOString(),
    };
  }
}

// ─── Quota tracker (in-memory only) ──────────────────────────────────────────

let quotaTracker = {};

function recordRequest(modelAlias, { promptTokens, completionTokens, latencyMs, util5hBefore, util5hAfter }) {
  if (!quotaTracker[modelAlias]) quotaTracker[modelAlias] = { requests: 0, promptTokens: 0, completionTokens: 0, totalLatencyMs: 0 };
  const t = quotaTracker[modelAlias];
  t.requests++;
  t.promptTokens     += promptTokens;
  t.completionTokens += completionTokens;
  t.totalLatencyMs   += latencyMs;
  const delta = (util5hBefore != null && util5hAfter != null) ? util5hAfter - util5hBefore : null;
  if (delta != null && delta > 0)
    log(`[quota] ${modelAlias}: 5h ${(util5hBefore*100).toFixed(1)}% → ${(util5hAfter*100).toFixed(1)}%`);
}

// ─── Session store ────────────────────────────────────────────────────────────

const SESSION_IDLE_MS = 30 * 60 * 1000;
const sessions = new Map();

function getSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.lastUsedAt > SESSION_IDLE_MS) { sessions.delete(id); return null; }
  return s;
}

function touchSession(id, modelAlias, history) {
  const existing = sessions.get(id);
  sessions.set(id, {
    modelAlias, history,
    createdAt:    existing?.createdAt ?? Date.now(),
    lastUsedAt:   Date.now(),
    messageCount: (existing?.messageCount ?? 0) + 1,
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions)
    if (now - s.lastUsedAt > SESSION_IDLE_MS) sessions.delete(id);
}, 60_000);

// ─── Mode 2: Claude subprocess worker ────────────────────────────────────────

class ClaudeWorker {
  constructor({ cwd = process.cwd() } = {}) {
    this.cwd = cwd;
    this.proc = null;
    this._pending = null;
    this._lastText = '';
    this._queue = [];
    this._ready = false;
    this.messageCount = 0;
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
  }

  _spawn() {
    log(`[worker] spawning claude (cwd: ${this.cwd})`);
    this.proc = spawn('claude', [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--permission-mode', 'bypassPermissions', '--no-session-persistence',
    ], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    const rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on('line', line => {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'system' && msg.subtype === 'init') { this._ready = true; log(`[worker] init received`); this._processQueue(); return; }
        if (this._ready) this._handle(msg);
      } catch (_) {}
    });
    this.proc.stderr.on('data', d => log(`[worker] ${d.toString().trim()}`));
    this.proc.on('exit', (code) => {
      log(`[worker] exited (code=${code})`);
      this._ready = false; this.proc = null;
      if (this._pending) { this._pending.reject(new Error('Worker exited unexpectedly')); this._pending = null; }
    });
    this.proc.on('error', e => { if (this._pending) { this._pending.reject(e); this._pending = null; } });
  }

  _handle(msg) {
    if (!this._pending) return;
    if (msg.type === 'assistant') {
      const text = (msg.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
      if (text.length > this._lastText.length) {
        const delta = text.slice(this._lastText.length);
        this._lastText = text;
        this._pending.onChunk?.(delta);
      }
    } else if (msg.type === 'result') {
      const p = this._pending; this._pending = null; this._lastText = '';
      if (msg.is_error) p.reject(new Error(msg.result || 'claude worker error'));
      else p.resolve({ text: msg.result, usage: msg.usage });
      this._processQueue();
    }
  }

  _write(content) {
    this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  }

  _processQueue() {
    if (this._queue.length === 0) return;
    const { content, resolve, reject, onChunk } = this._queue.shift();
    this._pending = { resolve, reject, onChunk };
    this._lastText = ''; this.messageCount++;
    this._write(content);
  }

  send(content, { onChunk } = {}) {
    this.lastUsedAt = Date.now();
    if (!this.proc || this.proc.killed) { this._ready = false; this._spawn(); }
    return new Promise((resolve, reject) => {
      if (this._pending || !this._ready) {
        this._queue.push({ content, resolve, reject, onChunk });
      } else {
        this._pending = { resolve, reject, onChunk };
        this._lastText = ''; this.messageCount++;
        this._write(content);
      }
    });
  }

  kill() { this.proc?.kill('SIGTERM'); this.proc = null; this._ready = false; }
}

const workerPool = new Map();
const WORKER_IDLE_MS = 30 * 60 * 1000;

function getWorker(sessionId, cwd) {
  const key = `${cwd}:${sessionId}`;
  if (!workerPool.has(key)) workerPool.set(key, new ClaudeWorker({ cwd }));
  return workerPool.get(key);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, w] of workerPool) {
    if (now - w.lastUsedAt > WORKER_IDLE_MS) { log(`[worker] reaping idle worker ${key}`); w.kill(); workerPool.delete(key); }
  }
}, 60_000);

function buildMode2Content(messages) {
  const system = messages.filter(m => m.role === 'system').map(m =>
    typeof m.content === 'string' ? m.content : (m.content || []).filter(p => p.type === 'text').map(p => p.text).join('')
  ).join('\n');
  const nonSystem = messages.filter(m => m.role !== 'system');
  const text = (m) => typeof m.content === 'string' ? m.content
    : (m.content || []).filter(p => p.type === 'text').map(p => p.text).join('');
  const body = nonSystem.length === 1 ? text(nonSystem[0])
    : nonSystem.map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${text(m)}`).join('\n');
  return system ? `${system}\n\n${body}` : body;
}

// ─── Format conversion ────────────────────────────────────────────────────────

function convertUserContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return content.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image_url') {
      const url = part.image_url?.url ?? '';
      if (url.startsWith('data:')) {
        const commaIdx = url.indexOf(',');
        const meta = url.slice(5, commaIdx);
        const data = url.slice(commaIdx + 1);
        return { type: 'image', source: { type: 'base64', media_type: meta.replace(';base64', ''), data } };
      }
      return { type: 'image', source: { type: 'url', url } };
    }
    return { type: 'text', text: JSON.stringify(part) };
  });
}

function convertMessages(messages) {
  const systemParts = [{ type: 'text', text: CLAUDE_CODE_SYS }];
  const anthropicMessages = [];
  for (const msg of messages) {
    if (msg.role === 'system') { systemParts.push({ type: 'text', text: String(msg.content) }); continue; }
    if (msg.role === 'tool') {
      const toolResult = { type: 'tool_result', tool_use_id: msg.tool_call_id,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) };
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(toolResult);
      else anthropicMessages.push({ role: 'user', content: [toolResult] });
      continue;
    }
    if (msg.role === 'assistant') {
      const content = [];
      const text = typeof msg.content === 'string' ? msg.content
        : (msg.content || []).filter(p => p.type === 'text').map(p => p.text).join('');
      if (text) content.push({ type: 'text', text });
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          content.push({ type: 'tool_use', id: tc.id, name: tc.function.name,
            input: (() => { try { return JSON.parse(tc.function.arguments || '{}'); } catch { return {}; } })() });
        }
      }
      anthropicMessages.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
      continue;
    }
    anthropicMessages.push({ role: 'user', content: convertUserContent(msg.content) });
  }
  return { system: systemParts, messages: anthropicMessages };
}

function convertToolChoice(toolChoice) {
  if (!toolChoice || toolChoice === 'none' || toolChoice === 'auto') return null;
  if (toolChoice === 'required') return { type: 'any' };
  if (typeof toolChoice === 'object' && toolChoice.type === 'function') return { type: 'tool', name: toolChoice.function.name };
  return null;
}

function convertTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map(t => {
    const fn = t.function ?? t;
    return { name: fn.name, description: fn.description || '', input_schema: fn.parameters || { type: 'object', properties: {} } };
  });
}

// ─── Core API call ────────────────────────────────────────────────────────────

async function callAnthropic({ modelId, messages, stream, maxTokens = 8192, tools, toolChoice }) {
  if (!cachedCreds) loadToken();
  const oauth = cachedCreds?.claudeAiOauth;
  if (oauth && oauth.expiresAt - Date.now() < 5 * 60_000) {
    log('Token expires within 5 min — refreshing before request...');
    await refreshToken();
  }
  const token = getToken();
  if (!token) throw new Error('No OAuth token available');

  const { system, messages: anthropicMessages } = convertMessages(messages);
  const anthropicTools = convertTools(tools);
  const bodyObj = { model: modelId, max_tokens: maxTokens, system, messages: anthropicMessages, stream: !!stream };
  if (anthropicTools?.length && toolChoice !== 'none') {
    bodyObj.tools = anthropicTools;
    const ac = convertToolChoice(toolChoice);
    if (ac) bodyObj.tool_choice = ac;
  }
  const bodyStr = JSON.stringify(bodyObj);

  return new Promise((resolve, reject) => {
    const req = https.request({
      host: API_HOST, path: '/v1/messages', method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': BETA_HEADERS,
        'anthropic-dangerous-direct-browser-access': 'true',
        'Content-Type': 'application/json',
        'x-app': 'cli',
        'user-agent': 'claude-cli/2.1.85 (external, cli)',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, resolve);
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Response conversion ──────────────────────────────────────────────────────

function anthropicToOpenAI(parsed, modelAlias, reqId) {
  const text        = (parsed.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
  const thinking    = (parsed.content ?? []).filter(b => b.type === 'thinking').map(b => b.thinking).join('');
  const toolUseBlks = (parsed.content ?? []).filter(b => b.type === 'tool_use');
  const message = {
    role: 'assistant', content: text || null,
    ...(thinking ? { thinking } : {}),
    ...(toolUseBlks.length ? {
      tool_calls: toolUseBlks.map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } })),
    } : {}),
  };
  const finishReason = parsed.stop_reason === 'tool_use' ? 'tool_calls'
    : parsed.stop_reason === 'end_turn' ? 'stop' : (parsed.stop_reason || 'stop');
  return {
    id: reqId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: modelAlias,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: parsed.usage?.input_tokens || 0, completion_tokens: parsed.usage?.output_tokens || 0,
             total_tokens: (parsed.usage?.input_tokens || 0) + (parsed.usage?.output_tokens || 0) },
  };
}

function makeChunk(reqId, modelAlias, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: reqId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelAlias,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function createSSEParser(modelAlias, reqId) {
  const toolBlocks = {};
  return function parseLine(line) {
    if (!line.startsWith('data: ')) return { out: null, done: false };
    const raw = line.slice(6);
    if (raw === '[DONE]') return { out: null, done: true };
    try {
      const evt = JSON.parse(raw);
      if (evt.type === 'message_stop') return { out: null, done: true };
      if (evt.type === 'message_start') return { out: makeChunk(reqId, modelAlias, { role: 'assistant', content: '' }), done: false };
      if (evt.type === 'content_block_start') {
        if (evt.content_block?.type === 'tool_use') {
          toolBlocks[evt.index] = { id: evt.content_block.id, name: evt.content_block.name, args: '' };
          return { out: makeChunk(reqId, modelAlias, {
            tool_calls: [{ index: evt.index, id: evt.content_block.id, type: 'function',
                           function: { name: evt.content_block.name, arguments: '' } }],
          }), done: false };
        }
        return { out: null, done: false };
      }
      if (evt.type === 'content_block_delta') {
        const d = evt.delta;
        if (d.type === 'text_delta')     return { out: makeChunk(reqId, modelAlias, { content: d.text }), done: false };
        if (d.type === 'thinking_delta') return { out: makeChunk(reqId, modelAlias, { thinking: d.thinking }), done: false };
        if (d.type === 'input_json_delta' && toolBlocks[evt.index] !== undefined) {
          toolBlocks[evt.index].args += d.partial_json;
          return { out: makeChunk(reqId, modelAlias, { tool_calls: [{ index: evt.index, function: { arguments: d.partial_json } }] }), done: false };
        }
        return { out: null, done: false };
      }
      if (evt.type === 'content_block_stop') return { out: null, done: false };
      if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
        const fr = evt.delta.stop_reason === 'tool_use' ? 'tool_calls'
          : evt.delta.stop_reason === 'end_turn' ? 'stop' : evt.delta.stop_reason;
        return { out: makeChunk(reqId, modelAlias, {}, fr), done: false };
      }
      return { out: null, done: false };
    } catch { return { out: null, done: false }; }
  };
}

// ─── complete() — POST /v1/chat/completions handler ──────────────────────────

async function complete(body, res) {
  const { messages: inMessages, model: modelReq, stream, max_tokens, session_id, tools, tool_choice } = body;
  if (!inMessages?.length) return jsonResp(res, 400, errBody('messages array is required'));

  // ── Agentic mode (claude -p subprocess) ───────────────────────────────────
  if (body.mode === 'agentic' || body.agentic === true) {
    const sid    = session_id || `agn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const cwd    = body.cwd || process.cwd();
    const worker = getWorker(sid, cwd);
    const reqId  = `agn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const content = worker.messageCount === 0
      ? buildMode2Content(inMessages)
      : (inMessages.filter(m => m.role === 'user').slice(-1)[0]?.content || '');

    log(`→ agentic | cwd=${cwd} | session=${sid} | turn=${worker.messageCount + 1}`);

    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const sseChunk = (delta) => res.write(`data: ${JSON.stringify({
        id: reqId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: 'claude-code-agentic', choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`);
      sseChunk({ role: 'assistant', content: '' });
      try {
        const { text, usage: agUsage } = await worker.send(content, { onChunk: (d) => sseChunk({ content: d }) });
        log(`← agentic done | ${text.length} chars | tokens=${agUsage?.input_tokens||0}+${agUsage?.output_tokens||0}`);
      } catch (err) {
        log(`ERROR agentic: ${err.message}`);
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      }
      res.write('data: [DONE]\n\n'); res.end(); return;
    } else {
      try {
        const t0 = Date.now();
        const { text, usage: agUsage } = await worker.send(content);
        const pt = agUsage?.input_tokens || 0, ct = agUsage?.output_tokens || 0;
        log(`← agentic done | ${Date.now()-t0}ms | ${text.length} chars | tokens=${pt}+${ct}`);
        return jsonResp(res, 200, {
          id: reqId, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
          model: 'claude-code-agentic', session_id: sid,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
        });
      } catch (err) {
        log(`ERROR agentic: ${err.message}`);
        return jsonResp(res, 500, errBody(err.message));
      }
    }
  }

  // ── Normal mode ───────────────────────────────────────────────────────────
  const modelEntry = resolveModel(modelReq);
  if (!modelEntry?.id) return jsonResp(res, 400, errBody(`Unknown model "${modelReq}".`));

  const session  = session_id ? getSession(session_id) : null;
  const messages = session
    ? [...session.history, ...inMessages.filter(m => m.role !== 'system')]
    : inMessages;

  const reqId = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  log(`→ ${modelEntry.id} | stream=${!!stream} | msgs=${messages.length}${session_id ? ` | session=${session_id}` : ''}`);

  // Rate-limit fallback
  let finalModel = modelEntry;
  const util = rateLimitStats[modelEntry.alias]?.util5h;
  if (util != null && util >= 0.99) {
    const fallback = Object.entries(MODELS).find(([alias]) =>
      alias !== modelEntry.alias && (rateLimitStats[alias]?.util5h ?? 0) < 0.99
    );
    if (fallback) {
      log(`[fallback] ${modelEntry.alias} at ${(util*100).toFixed(0)}% → using ${fallback[0]}`);
      finalModel = { alias: fallback[0], ...fallback[1] };
    } else {
      return jsonResp(res, 503, errBody('All models are rate-limited. Check /anthropic/quota for reset times.'));
    }
  }

  try {
    const util5hBefore = rateLimitStats[finalModel.alias]?.util5h ?? null;

    const t0 = Date.now();
    const anthropicRes = await callAnthropic({ modelId: finalModel.id, messages, stream, maxTokens: max_tokens, tools, toolChoice: tool_choice });
    updateRateLimits(finalModel.alias, anthropicRes.headers);

    if (stream) {
      if (anthropicRes.statusCode !== 200) {
        let errData = '';
        anthropicRes.on('data', c => errData += c);
        await new Promise(r => anthropicRes.on('end', r));
        try { return jsonResp(res, anthropicRes.statusCode, errBody(JSON.parse(errData).error?.message || errData)); }
        catch { return jsonResp(res, anthropicRes.statusCode, errBody(errData)); }
      }
      const streamHeaders = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' };
      const rlS = rateLimitStats[finalModel.alias] ?? {};
      if (rlS.resetAt5h != null)  streamHeaders['x-ratelimit-reset-tokens']       = rlS.resetAt5h;
      if (rlS.util5h    != null)  streamHeaders['x-ratelimit-utilization-5h']     = `${(rlS.util5h*100).toFixed(1)}%`;
      if (rlS.util7d    != null)  streamHeaders['x-ratelimit-utilization-7d']     = `${(rlS.util7d*100).toFixed(1)}%`;
      res.writeHead(200, streamHeaders);
      let buf = '', streamDone = false;
      const parseSSE = createSSEParser(finalModel.alias, reqId);
      const streamUsage = { input: 0, output: 0 };
      anthropicRes.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === 'message_start') streamUsage.input  = evt.message?.usage?.input_tokens  ?? 0;
              if (evt.type === 'message_delta' && evt.usage) streamUsage.output = evt.usage.output_tokens ?? 0;
            } catch (_) {}
          }
          const { out, done } = parseSSE(line);
          if (out) res.write(out);
          if (done && !streamDone) {
            streamDone = true;
            const latencyMs = Date.now() - t0;
            recordRequest(finalModel.alias, { promptTokens: streamUsage.input, completionTokens: streamUsage.output,
              latencyMs, util5hBefore, util5hAfter: rateLimitStats[finalModel.alias]?.util5h ?? null });
            res.write('data: [DONE]\n\n'); res.end();
            log(`← ${finalModel.id} stream done | tokens=${streamUsage.input}+${streamUsage.output} | ${latencyMs}ms`);
          }
        }
      });
      anthropicRes.on('end', () => { if (!streamDone) { res.write('data: [DONE]\n\n'); res.end(); } });
      return;
    } else {
      let rawData = '';
      anthropicRes.on('data', c => rawData += c);
      await new Promise(r => anthropicRes.on('end', r));
      if (anthropicRes.statusCode !== 200) {
        try { return jsonResp(res, anthropicRes.statusCode, errBody(JSON.parse(rawData).error?.message || rawData)); }
        catch { return jsonResp(res, anthropicRes.statusCode, errBody(rawData)); }
      }
      const parsed = JSON.parse(rawData);
      if (parsed.type === 'error') return jsonResp(res, 500, errBody(parsed.error?.message || JSON.stringify(parsed.error)));
      const latencyMs = Date.now() - t0;
      recordRequest(finalModel.alias, { promptTokens: parsed.usage?.input_tokens||0, completionTokens: parsed.usage?.output_tokens||0,
        latencyMs, util5hBefore, util5hAfter: rateLimitStats[finalModel.alias]?.util5h ?? null });
      log(`← ${finalModel.id} done | tokens=${parsed.usage?.output_tokens} | ${latencyMs}ms`);
      if (session_id) {
        const assistant = { role: 'assistant', content: parsed.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '' };
        touchSession(session_id, finalModel.alias, [...messages, assistant]);
      }
      const rl = rateLimitStats[finalModel.alias] ?? {};
      if (rl.resetAt5h != null) res.setHeader('x-ratelimit-reset-tokens',   rl.resetAt5h);
      if (rl.util5h    != null) res.setHeader('x-ratelimit-utilization-5h', `${(rl.util5h*100).toFixed(1)}%`);
      if (rl.util7d    != null) res.setHeader('x-ratelimit-utilization-7d', `${(rl.util7d*100).toFixed(1)}%`);
      return jsonResp(res, 200, {
        ...anthropicToOpenAI(parsed, finalModel.alias, reqId),
        ...(session_id ? { session_id } : {}),
        ...(finalModel.alias !== modelEntry.alias ? { requested_model: modelEntry.alias } : {}),
      });
    }
  } catch (err) {
    log(`ERROR: ${err.message}`);
    return jsonResp(res, 500, errBody(err.message));
  }
}

// ─── handleAdminRequest() — /sessions, /quota, /workers, /v1/models ──────────

function handleAdminRequest(path, method, body, res) {
  // GET /health
  if (method === 'GET' && path === '/health') {
    const token = getToken();
    const oauth = cachedCreds?.claudeAiOauth;
    return jsonResp(res, token ? 200 : 503, {
      status: token ? 'ok' : 'no_token',
      plan:   oauth?.subscriptionType || 'unknown',
      tier:   oauth?.rateLimitTier    || 'unknown',
      tokenExpiresAt: oauth ? new Date(oauth.expiresAt).toISOString() : null,
    });
  }

  // GET /quota
  if (method === 'GET' && path === '/quota') {
    const data = Object.entries(MODELS).map(([alias, m]) => {
      const t  = quotaTracker[alias] ?? {};
      const rl = rateLimitStats[alias] ?? {};
      const requests         = t.requests         ?? 0;
      const promptTokens     = t.promptTokens     ?? 0;
      const completionTokens = t.completionTokens ?? 0;
      const avgLatencyMs     = requests > 0 ? Math.round(t.totalLatencyMs / requests) : null;
      return {
        model: `claude/${alias}`, label: m.label,
        rate_limits: {
          limit_requests:     'NOT_SUPPORTED',
          remaining_requests: 'NOT_SUPPORTED',
          reset_requests:     'NOT_SUPPORTED',
          limit_tokens:       'NOT_SUPPORTED',
          remaining_tokens:   'NOT_SUPPORTED',
          reset_tokens:       rl.resetAt5h ?? 'NOT_SUPPORTED',
        },
        provider_quota: {
          util_5h:  rl.util5h  != null ? `${(rl.util5h*100).toFixed(1)}%`  : 'NOT_SUPPORTED',
          util_7d:  rl.util7d  != null ? `${(rl.util7d*100).toFixed(1)}%`  : 'NOT_SUPPORTED',
          reset_at: rl.resetAt5h ?? 'NOT_SUPPORTED',
        },
        session_usage: {
          requests,
          prompt_tokens:     promptTokens,
          completion_tokens: completionTokens,
          total_tokens:      promptTokens + completionTokens,
          avg_latency_ms:    avgLatencyMs,
        },
      };
    });
    return jsonResp(res, 200, { object: 'list', data });
  }

  // GET /sessions
  if (method === 'GET' && path === '/sessions') {
    const list = [...sessions.entries()].map(([id, s]) => ({
      session_id: id, model: s.modelAlias,
      created_at:   new Date(s.createdAt).toISOString(),
      last_used_at: new Date(s.lastUsedAt).toISOString(),
      idle_for:     `${Math.round((Date.now()-s.lastUsedAt)/1000)}s`,
      messages:     s.messageCount, history_len: s.history.length,
    }));
    return jsonResp(res, 200, { sessions: list, count: list.length });
  }

  // DELETE /sessions/:id
  const delSession = path.match(/^\/sessions\/(.+)$/);
  if (method === 'DELETE' && delSession) {
    const id = delSession[1];
    if (sessions.has(id)) { sessions.delete(id); return jsonResp(res, 200, { deleted: id }); }
    return jsonResp(res, 404, errBody(`Session ${id} not found`));
  }

  // GET /workers
  if (method === 'GET' && path === '/workers') {
    const list = [...workerPool.entries()].map(([key, w]) => ({
      key, cwd: w.cwd, session_id: key.slice(w.cwd.length + 1),
      message_count: w.messageCount,
      created_at:    new Date(w.createdAt).toISOString(),
      last_used_at:  new Date(w.lastUsedAt).toISOString(),
      idle_for:      `${Math.round((Date.now()-w.lastUsedAt)/1000)}s`,
      alive:  !!(w.proc && !w.proc.killed), queued: w._queue.length,
    }));
    return jsonResp(res, 200, { workers: list, count: list.length });
  }

  // DELETE /workers/:key
  const delWorker = path.match(/^\/workers\/(.+)$/);
  if (method === 'DELETE' && delWorker) {
    const key = decodeURIComponent(delWorker[1]);
    if (workerPool.has(key)) { workerPool.get(key).kill(); workerPool.delete(key); return jsonResp(res, 200, { deleted: key }); }
    return jsonResp(res, 404, errBody(`Worker ${key} not found`));
  }

  // GET /v1/models
  if (method === 'GET' && path === '/v1/models') {
    const data = Object.entries(MODELS).map(([alias, m]) => {
      const rl = rateLimitStats[alias] ?? {};
      return { id: alias, object: 'model', label: m.label, model_id: m.id,
        rate_limits: rl.util5h != null ? { util5h: `${(rl.util5h*100).toFixed(1)}%`,
          util7d: rl.util7d != null ? `${(rl.util7d*100).toFixed(1)}%` : null, resetAt5h: rl.resetAt5h } : null };
    });
    return jsonResp(res, 200, { object: 'list', data });
  }

  jsonResp(res, 404, errBody(`Unknown admin endpoint: ${method} ${path}`));
}

// ─── Backend interface ────────────────────────────────────────────────────────

module.exports = {
  id:     'anthropic',
  prefix: 'claude',

  async init() {
    loadToken();
    // Proactive refresh: every 5 min, refresh if token expires within 30 min
    setInterval(() => {
      const oauth = cachedCreds?.claudeAiOauth;
      if (oauth && oauth.expiresAt - Date.now() < 30 * 60_000) refreshToken();
    }, 5 * 60_000);
    log('Anthropic backend ready');
  },

  async models() {
    return Object.entries(MODELS).map(([alias, m]) => ({ id: alias, label: m.label }));
  },

  async health() {
    const token = getToken();
    const oauth = cachedCreds?.claudeAiOauth;
    return {
      status: token ? 'ok' : 'no_token',
      plan:   oauth?.subscriptionType || 'unknown',
      tier:   oauth?.rateLimitTier    || 'unknown',
      tokenExpiresAt: oauth ? new Date(oauth.expiresAt).toISOString() : null,
    };
  },

  complete,
  handleAdminRequest,
};
