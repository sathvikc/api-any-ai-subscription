'use strict';

/**
 * Antigravity backend driver.
 * Talks to the local Antigravity (Google) language server over H2C (HTTP/2 cleartext).
 * Discovers the server port at runtime by inspecting the running language_server process.
 *
 * Interface: { id, prefix, init, models, health, complete, handleAdminRequest }
 */

const http2      = require('http2');
const fs         = require('fs');
const { execSync } = require('child_process');
const crypto     = require('crypto');

const LOG_FILE        = '/tmp/bridge_v7.log';
const MIN_REQUEST_GAP = parseInt(process.env.MIN_REQUEST_GAP_MS ?? '3000');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
  console.log(`[antigravity] ${msg}`);
}

function jsonResp(res, status, data) {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

function errBody(msg) {
  return { error: { message: String(msg), type: 'invalid_request_error', code: null } };
}

// ─── Throttle ─────────────────────────────────────────────────────────────────

let lastRequestAt = 0;
async function throttle() {
  const gap    = MIN_REQUEST_GAP * (0.7 + Math.random() * 0.6);
  const waited = Date.now() - lastRequestAt;
  if (waited < gap) await new Promise(r => setTimeout(r, gap - waited));
  lastRequestAt = Date.now();
}

// ─── Quota tracker (in-memory only) ──────────────────────────────────────────

let quotaTracker = {};

async function snapshotQuota() {
  try {
    const data = await rpc('/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData', {});
    const snap = {};
    for (const c of data?.clientModelConfigs ?? []) {
      const label    = c.label ?? 'unknown';
      const modelStr = c.modelOrAlias?.model ?? '';
      const mMatch   = modelStr.match(/MODEL_PLACEHOLDER_M(\d+)/);
      snap[label] = {
        planModel:         mMatch ? 1000 + parseInt(mMatch[1]) : null,
        remainingFraction: c.quotaInfo?.remainingFraction ?? null,
        resetTime:         c.quotaInfo?.resetTime ?? null,
      };
    }
    return snap;
  } catch (_) { return null; }
}

function recordRequest(label, planModel, { before, after, promptChars, responseChars, latencyMs, resetTime }) {
  if (!quotaTracker[label]) quotaTracker[label] = { planModel, requests: 0, promptCharsTotal: 0, responseCharsTotal: 0, totalLatencyMs: 0 };
  const t = quotaTracker[label];
  t.requests++;
  t.promptCharsTotal   += promptChars;
  t.responseCharsTotal += responseChars;
  if (latencyMs > 0) t.totalLatencyMs += latencyMs;
  if (after    != null) t.lastRemainingFraction = after;
  if (resetTime != null) t.lastResetTime = resetTime;
  const delta = (before !== null && after !== null) ? before - after : 0;
  if (delta > 0)
    log(`[quota] ${label}: ${(before*100).toFixed(1)}% → ${(after*100).toFixed(1)}% (−${(delta*100).toFixed(2)}%)`);
}

// ─── Discovery ────────────────────────────────────────────────────────────────

async function probePort(port, useHttps, token) {
  return new Promise(resolve => {
    const url  = `${useHttps ? 'https' : 'http'}://127.0.0.1:${port}`;
    const opts = useHttps ? { rejectUnauthorized: false } : {};
    let client;
    const timer = setTimeout(() => { try { client?.close(); } catch (_) {} resolve(null); }, 2000);
    try {
      client = http2.connect(url, opts);
      client.on('error', () => { clearTimeout(timer); resolve(null); });
      const req = client.request({
        ':method': 'POST', ':path': '/exa.language_server_pb.LanguageServerService/StartCascade',
        'content-type': 'application/json', 'x-codeium-csrf-token': token, 'connect-protocol-version': '1',
      });
      req.on('response', h => {
        clearTimeout(timer);
        req.destroy(); client.close();
        resolve(h[':status'] >= 200 ? { port, https: useHttps } : null);
      });
      req.on('error', () => { clearTimeout(timer); resolve(null); });
      req.write(JSON.stringify({ cascadeId: 'probe-not-a-uuid' }));
      req.end();
    } catch (_) { clearTimeout(timer); resolve(null); }
  });
}

async function discoverContext() {
  let ps;
  try {
    ps = execSync('ps aux | grep language_server_macos_arm | grep -v grep').toString().trim().split('\n')[0];
  } catch (_) { ps = ''; }
  if (!ps) throw new Error('Antigravity is not running — please open the IDE and try again');

  const token   = ps.match(/--csrf_token\s+([a-f0-9-]+)/)?.[1];
  const extPort = parseInt(ps.match(/--extension_server_port\s+(\d+)/)?.[1] || '0');
  const pid     = ps.match(/^\S+\s+(\d+)/)?.[1];
  if (!token || !pid) throw new Error('language_server_macos_arm not found or missing flags');

  const workspaceId = ps.match(/--workspace_id\s+(\S+)/)?.[1] || '';
  let workspaceUri  = `file://${process.cwd()}`;
  if (workspaceId) {
    const wsStorageBase = `${process.env.HOME}/Library/Application Support/Antigravity/User/workspaceStorage`;
    try {
      const dirs = fs.readdirSync(wsStorageBase);
      for (const dir of dirs) {
        const wjPath = `${wsStorageBase}/${dir}/workspace.json`;
        if (!fs.existsSync(wjPath)) continue;
        const folder    = JSON.parse(fs.readFileSync(wjPath, 'utf8')).folder || '';
        const candidate = 'file' + folder.replace('file://', '').replace(/[\/-]/g, '_');
        if (candidate === workspaceId) { workspaceUri = folder; break; }
      }
    } catch (_) {}
  }

  const lsof  = execSync(`lsof -a -p ${pid} -iTCP -sTCP:LISTEN -n -P`).toString();
  const ports = [...lsof.matchAll(/:(\d+)\s+\(LISTEN\)/g)]
    .map(m => parseInt(m[1])).filter(p => p !== extPort);

  log(`PID ${pid}  token ${token}  workspace ${workspaceUri}  candidates ${ports.join(',')}`);

  for (const useHttps of [false, true]) {
    for (const p of ports) {
      const result = await probePort(p, useHttps, token);
      if (result) { log(`Using port ${p} ${useHttps ? 'HTTPS' : 'HTTP'}`); return { token, port: p, https: useHttps, workspaceUri }; }
    }
  }
  throw new Error('No responding port found');
}

// ─── RPC helpers ──────────────────────────────────────────────────────────────

let CTX = null;
let H2C = null;

function getClient() {
  if (H2C && !H2C.destroyed) return H2C;
  const url  = `${CTX.https ? 'https' : 'http'}://127.0.0.1:${CTX.port}`;
  const opts = CTX.https ? { rejectUnauthorized: false } : {};
  H2C = http2.connect(url, opts);
  H2C.on('error',  e => { log('h2 error: ' + e.message); H2C = null; CTX = null; });
  H2C.on('close',  () => { H2C = null; CTX = null; });
  return H2C;
}

function rpc(path, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const client = getClient();
    const timer  = setTimeout(() => reject(new Error(`RPC timeout: ${path}`)), timeoutMs);
    let req;
    try {
      req = client.request({
        ':method': 'POST', ':path': path,
        'content-type': 'application/json',
        'x-codeium-csrf-token': CTX.token,
        'connect-protocol-version': '1',
      });
    } catch (e) { clearTimeout(timer); return reject(e); }
    let buf = '';
    req.on('response', h => {
      const status = h[':status'];
      req.on('data', d => buf += d);
      req.on('end', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(buf);
          if (status >= 400) reject(new Error(`RPC ${status}: ${buf}`));
          else resolve(parsed);
        } catch (_) {
          if (status >= 400) reject(new Error(`RPC ${status}: ${buf}`));
          else resolve(buf);
        }
      });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Model registry ───────────────────────────────────────────────────────────

const MODELS = {
  'gemini-flash':    { planModel: 1047, label: 'Gemini 3 Flash',               headless: true  },
  'gemini-pro-high': { planModel: 1037, label: 'Gemini 3.1 Pro (High)',         headless: true  },
  'gemini-pro-low':  { planModel: 1036, label: 'Gemini 3.1 Pro (Low)',          headless: true  },
  'claude-sonnet':   { planModel: 1035, label: 'Claude Sonnet 4.6 (Thinking)',  headless: true  },
  'claude-opus':     { planModel: 1026, label: 'Claude Opus 4.6 (Thinking)',    headless: true  },
  'gpt-oss':         { planModel: null, label: 'GPT-OSS 120B (Medium)',         headless: false },
};
const DEFAULT_MODEL          = 'gemini-flash';
const DEFAULT_CASCADE_CONFIG = buildCascadeConfig(DEFAULT_MODEL);

function buildCascadeConfig(modelId, overrides = {}) {
  const m = MODELS[modelId] ?? MODELS[DEFAULT_MODEL];
  return {
    plannerConfig: { planModel: m.planModel, maxOutputTokens: 8192,
      conversational: { agenticMode: true }, ...overrides.plannerConfig },
    checkpointConfig: { maxOutputTokens: 8192, ...overrides.checkpointConfig },
  };
}

// ─── Session store ────────────────────────────────────────────────────────────

const SESSION_IDLE_MS = 30 * 60 * 1000;
const sessions = new Map();

function getSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (Date.now() - s.lastUsedAt > SESSION_IDLE_MS) { sessions.delete(sessionId); log(`[session] ${sessionId} expired`); return null; }
  return s;
}

function touchSession(sessionId, cascadeId, modelId) {
  const existing = sessions.get(sessionId);
  const now = Date.now();
  sessions.set(sessionId, { cascadeId, modelId,
    createdAt:    existing?.createdAt ?? now,
    lastUsedAt:   now,
    messageCount: (existing?.messageCount ?? 0) + 1,
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastUsedAt > SESSION_IDLE_MS) sessions.delete(id);
}, 60_000);

// ─── Message building ─────────────────────────────────────────────────────────

const FILES_ONLY_CONSTRAINT = `IMPORTANT CONSTRAINT: You may only read and write files. Do NOT use run_command, execute scripts, or run any shell commands. If you need to verify something, do it by reading the file you just wrote. Never generate a RUN_COMMAND step.`;

function buildItems(messages, toolsMode = 'files_only') {
  const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);
  if (toolsMode === 'files_only') {
    systemParts.push(FILES_ONLY_CONSTRAINT);
    if (CTX?.workspaceUri) {
      const workspacePath = CTX.workspaceUri.replace(/^file:\/\//, '');
      systemParts.push(`WORKSPACE CONSTRAINT: Only read and write files within the workspace directory: ${workspacePath}. Do NOT access files outside this directory.`);
    }
  }
  const nonSystem  = messages.filter(m => m.role !== 'system');
  const userItems  = nonSystem.length === 1
    ? messageParts(nonSystem[0])
    : [{ text: nonSystem.map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${contentText(m)}`).join('\n') + '\nAssistant:' }];
  return systemParts.length ? [{ text: systemParts.join('\n') + '\n\n' }, ...userItems] : userItems;
}

function contentText(msg) {
  if (typeof msg.content === 'string') return msg.content;
  return (msg.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('');
}

function messageParts(msg) {
  if (typeof msg.content === 'string') return [{ text: msg.content }];
  return (msg.content ?? []).map(part => {
    if (part.type === 'text') return { text: part.text };
    if (part.type === 'image_url') {
      const url = part.image_url?.url ?? '';
      if (url.startsWith('data:')) {
        const [meta, data] = url.split(',');
        return { image: { mimeType: meta.replace('data:', '').replace(';base64', ''), data } };
      }
      return { text: `[Image: ${url}]` };
    }
    return { text: JSON.stringify(part) };
  });
}

// ─── sendMessage (polling) ────────────────────────────────────────────────────

async function sendMessage(items, cascadeConfig, existingCascadeId = null) {
  const cascadeId = existingCascadeId ?? crypto.randomUUID();
  const LS = '/exa.language_server_pb.LanguageServerService/';

  let stepBaseline = 0;
  if (existingCascadeId) {
    log(`[${cascadeId}] Resuming — snapshotting step baseline`);
    const prev = await rpc(LS + 'GetCascadeTrajectory', { cascadeId });
    stepBaseline = prev?.trajectory?.steps?.length ?? 0;
    log(`[${cascadeId}] Step baseline: ${stepBaseline}`);
  } else {
    log(`[${cascadeId}] StartCascade`);
    await rpc(LS + 'StartCascade', { cascadeId, workspaceUris: [CTX.workspaceUri],
      source: 'CORTEX_TRAJECTORY_SOURCE_SDK', trajectoryType: 'CORTEX_TRAJECTORY_TYPE_INTERACTIVE_CASCADE' });
  }

  log(`[${cascadeId}] SendUserCascadeMessage`);
  await rpc(LS + 'SendUserCascadeMessage', { cascadeId, items, cascadeConfig: cascadeConfig || DEFAULT_CASCADE_CONFIG });

  log(`[${cascadeId}] Polling for response...`);
  let lastStepCount = -1, stablePolls = 0;

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const data     = await rpc(LS + 'GetCascadeTrajectory', { cascadeId });
    const allSteps = data?.trajectory?.steps || [];
    const steps    = allSteps.slice(stepBaseline);
    const inFlight = steps.some(s =>
      s.status === 'CORTEX_STEP_STATUS_PENDING' || s.status === 'CORTEX_STEP_STATUS_RUNNING' || s.status === 'CORTEX_STEP_STATUS_GENERATING');

    if (steps.length === lastStepCount && !inFlight) stablePolls++;
    else { stablePolls = 0; lastStepCount = steps.length; }

    const statuses = steps.map(s => s.type?.replace('CORTEX_STEP_TYPE_','') + ':' + s.status?.replace('CORTEX_STEP_STATUS_','')).join(' | ');
    log(`[${cascadeId}] poll ${i+1} [stable=${stablePolls}/2 inflight=${inFlight}]: ${statuses}`);

    if (stablePolls >= 2) {
      const plannerStep = steps.findLast(s =>
        s.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && s.status === 'CORTEX_STEP_STATUS_DONE');
      if (!plannerStep) continue;

      const raw = plannerStep.plannerResponse?.response || plannerStep.plannerResponse?.modifiedResponse || '';
      let text = raw;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.toolCalls || parsed?.stopReason?.includes('TOOL')) { stablePolls = 0; continue; }
        if (typeof parsed?.response === 'string') text = parsed.response;
        else if (typeof parsed?.thinking === 'string' && !parsed?.toolCalls) text = parsed.thinking;
      } catch (_) {}

      const actions = steps
        .filter(s => s.type === 'CORTEX_STEP_TYPE_CODE_ACTION' && s.status === 'CORTEX_STEP_STATUS_DONE')
        .map((s, i) => {
          const tc = s.metadata?.toolCall ?? {};
          const args = tc.argumentsJson ?? JSON.stringify({ description: s.codeAction?.description ?? '' });
          return { id: `act-${i}`, type: 'function', function: { name: tc.name ?? 'unknown', arguments: args } };
        });
      if (actions.length) log(`[${cascadeId}] Tools used: ${actions.map(a => a.function.name).join(', ')}`);
      if (text.includes('STOP_REASON_CLIENT_STREAM_ERROR')) throw new Error('STOP_REASON_CLIENT_STREAM_ERROR');
      if (!text.trim()) text = actions.length ? `Done. Actions taken: ${actions.join('; ')}` : '(no response text)';
      log(`[${cascadeId}] Response (${text.length} chars): ${text.slice(0, 100)}...`);
      return { text, cascadeId, steps: steps.length, actions };
    }
  }
  throw new Error('Timed out waiting for planner response');
}

// ─── streamMessage (Connect streaming) ───────────────────────────────────────

function encodeConnectFrame(body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const frame   = Buffer.allocUnsafe(5 + payload.length);
  frame[0] = 0x00;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

async function* streamMessage(items, cascadeConfig, existingCascadeId = null) {
  const cascadeId = existingCascadeId ?? crypto.randomUUID();
  const LS = '/exa.language_server_pb.LanguageServerService/';

  if (existingCascadeId) {
    log(`[${cascadeId}] stream: resuming`);
  } else {
    log(`[${cascadeId}] stream: StartCascade`);
    await rpc(LS + 'StartCascade', { cascadeId, workspaceUris: [CTX.workspaceUri],
      source: 'CORTEX_TRAJECTORY_SOURCE_SDK', trajectoryType: 'CORTEX_TRAJECTORY_TYPE_INTERACTIVE_CASCADE' });
  }

  const url        = `${CTX.https ? 'https' : 'http'}://127.0.0.1:${CTX.port}`;
  const opts       = CTX.https ? { rejectUnauthorized: false } : {};
  const streamClient = http2.connect(url, opts);
  streamClient.on('error', e => log(`[${cascadeId}] stream h2 error: ${e.message}`));

  const queue = []; let streamDone = false, streamError = null, resolveWaiter = null;
  function pushEvent(event) { queue.push(event); if (resolveWaiter) { resolveWaiter(); resolveWaiter = null; } }

  const frame     = encodeConnectFrame({ conversationId: cascadeId, subscriberId: crypto.randomUUID() });
  const streamReq = streamClient.request({
    ':method': 'POST', ':path': LS + 'StreamAgentStateUpdates',
    'content-type': 'application/connect+json', 'x-codeium-csrf-token': CTX.token,
    'connect-protocol-version': '1', 'content-length': frame.length,
  });
  streamReq.write(frame); streamReq.end();

  let rawBuf = Buffer.alloc(0);
  streamReq.on('data', chunk => {
    rawBuf = Buffer.concat([rawBuf, chunk]);
    let offset = 0;
    while (offset + 5 <= rawBuf.length) {
      const len = rawBuf.readUInt32BE(offset + 1);
      if (offset + 5 + len > rawBuf.length) break;
      const payload = rawBuf.slice(offset + 5, offset + 5 + len);
      offset += 5 + len;
      try {
        const parsed = JSON.parse(payload.toString('utf8'));
        if (parsed?.error) { streamError = new Error(parsed.error.message || 'stream error'); pushEvent({ error: streamError }); }
        else pushEvent({ update: parsed.update });
      } catch (e) { log(`[${cascadeId}] stream frame parse error: ${e.message}`); }
    }
    rawBuf = rawBuf.slice(offset);
  });
  streamReq.on('end',   () => { streamDone = true; pushEvent({ done: true }); });
  streamReq.on('error', e  => { streamError = e; pushEvent({ error: e }); });

  async function nextEvent() {
    if (queue.length > 0) return queue.shift();
    return new Promise(resolve => { resolveWaiter = () => resolve(queue.shift()); });
  }

  log(`[${cascadeId}] stream: SendUserCascadeMessage`);
  await rpc(LS + 'SendUserCascadeMessage', { cascadeId, items, cascadeConfig: cascadeConfig || DEFAULT_CASCADE_CONFIG });

  let lastText = '', finalText = '', seenDonePlanner = false;
  const actions  = [];
  const deadline = Date.now() + 120_000;

  try {
    while (Date.now() < deadline) {
      const event = await Promise.race([nextEvent(), new Promise(r => setTimeout(() => r({ timeout: true }), 5000))]);
      if (event.timeout) { if (seenDonePlanner && streamDone) break; continue; }
      if (event.error) throw event.error;
      if (event.done) break;

      const update       = event.update;
      if (!update) continue;
      const stepsUpdate  = update.mainTrajectoryUpdate?.stepsUpdate;

      if (stepsUpdate?.steps) {
        for (const step of stepsUpdate.steps) {
          if (step.type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') continue;
          const status = step.status;
          if (status !== 'CORTEX_STEP_STATUS_GENERATING' && status !== 'CORTEX_STEP_STATUS_DONE') continue;
          const text = step.plannerResponse?.modifiedResponse || '';
          if (text) {
            try { const p = JSON.parse(text); if (p?.toolCalls || p?.stopReason?.includes('TOOL')) continue; } catch (_) {}
          }
          if (text.length > lastText.length) { const delta = text.slice(lastText.length); lastText = text; yield { delta }; }
          if (status === 'CORTEX_STEP_STATUS_DONE') { seenDonePlanner = true; finalText = text; }
        }

        for (const step of stepsUpdate.steps) {
          if (step.type === 'CORTEX_STEP_TYPE_CODE_ACTION' && step.status === 'CORTEX_STEP_STATUS_DONE') {
            const tc   = step.metadata?.toolCall ?? {};
            const args = tc.argumentsJson ?? JSON.stringify({ description: step.codeAction?.description ?? '' });
            actions.push({ id: `act-${actions.length}`, type: 'function', function: { name: tc.name ?? 'unknown', arguments: args } });
          }
        }
      }

      if (seenDonePlanner && update.status === 'CASCADE_RUN_STATUS_IDLE' && update.executableStatus === 'CASCADE_RUN_STATUS_IDLE') {
        log(`[${cascadeId}] stream done — ${finalText.length} chars`);
        yield { done: true, cascadeId, actions, fullText: finalText };
        return;
      }
    }
  } finally { streamClient.close(); }

  if (!seenDonePlanner) throw new Error('Timed out waiting for streamed response');
  yield { done: true, cascadeId, actions, fullText: finalText };
}

// ─── complete() — POST /v1/chat/completions handler ──────────────────────────

async function complete(body, res) {
  const messages = body.messages ?? [];
  if (!messages.length) return jsonResp(res, 400, errBody('No messages provided'));

  const modelId   = body.model ?? DEFAULT_MODEL;
  const modelInfo = MODELS[modelId];
  if (!modelInfo) {
    return jsonResp(res, 400, errBody(`Unknown model "${modelId}". Available: ${Object.keys(MODELS).join(', ')}`));
  }
  if (!modelInfo.headless) {
    return jsonResp(res, 400, errBody(`Model "${modelId}" (${modelInfo.label}) is not available headlessly. Use: ${Object.entries(MODELS).filter(([,m]) => m.headless).map(([id]) => id).join(', ')}`));
  }

  const wantsStream = body.stream === true;

  // Auto fallback if model is quota-exhausted
  let resolvedModelId = modelId, resolvedModelInfo = modelInfo;
  if (!body.cascadeConfig) {
    try {
      if (!CTX) CTX = await discoverContext();
      const liveData = await rpc('/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData', {});
      const quotaMap = {};
      for (const c of liveData?.clientModelConfigs ?? []) quotaMap[c.label] = c.quotaInfo?.remainingFraction ?? 1;
      if ((quotaMap[modelInfo.label] ?? 1) === 0) {
        const fallback = Object.entries(MODELS).find(([id, m]) => m.headless && id !== modelId && (quotaMap[m.label] ?? 1) > 0);
        if (fallback) { log(`[fallback] ${modelId} exhausted → using ${fallback[0]}`); resolvedModelId = fallback[0]; resolvedModelInfo = fallback[1]; }
        else return jsonResp(res, 503, errBody('All models are rate-limited. Check /google/quota for reset times.'));
      }
    } catch (_) {}
  }

  const sessionId         = body.session_id ?? null;
  const session           = sessionId ? getSession(sessionId) : null;
  const existingCascadeId = session?.cascadeId ?? null;
  const toolsMode         = body.tools ?? 'files_only';
  const itemMessages      = session ? messages.filter(m => m.role !== 'assistant').slice(-1) : messages;
  const items             = buildItems(itemMessages, toolsMode);
  const promptChars       = items.reduce((s, i) => s + (i.text?.length ?? 0), 0);
  const cascadeConfig     = body.cascadeConfig ?? buildCascadeConfig(resolvedModelId);

  try {
    await throttle();
    if (!CTX) CTX = await discoverContext();

    // ── Streaming ────────────────────────────────────────────────────────────
    if (wantsStream) {
      const reqId = `cascade-${crypto.randomUUID()}`;
      const lastKnown = Object.values(quotaTracker).find(t => t.planModel === resolvedModelInfo.planModel);
      const streamHeaders = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' };
      if (lastKnown?.lastRemainingFraction != null) streamHeaders['x-ratelimit-remaining-fraction'] = `${(lastKnown.lastRemainingFraction*100).toFixed(1)}%`;
      if (lastKnown?.lastResetTime  != null) streamHeaders['x-ratelimit-reset-tokens'] = lastKnown.lastResetTime;
      res.writeHead(200, streamHeaders);

      const sseChunk = (delta) => res.write(`data: ${JSON.stringify({
        id: reqId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: resolvedModelId,
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`);
      sseChunk({ role: 'assistant', content: '' });

      let fullText = '', streamActions = [];
      try {
        const gen = streamMessage(items, cascadeConfig, existingCascadeId);
        for await (const event of gen) {
          if (event.done) {
            streamActions = event.actions ?? [];
            if (sessionId) touchSession(sessionId, event.cascadeId, resolvedModelId);
            snapshotQuota().then(snap => {
              if (snap) for (const label of Object.keys(snap))
                recordRequest(label, snap[label].planModel, {
                  before: null, after: snap[label].remainingFraction,
                  promptChars, responseChars: fullText.length, latencyMs: 0,
                  resetTime: snap[label].resetTime,
                });
            }).catch(() => {});
          } else if (event.delta) { fullText += event.delta; sseChunk({ content: event.delta }); }
        }
        if (streamActions.length > 0) {
          res.write(`data: ${JSON.stringify({ id: reqId, object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model: resolvedModelId,
            choices: [{ index: 0, delta: { tool_calls: streamActions }, finish_reason: 'tool_calls' }],
          })}\n\n`);
        }
      } catch (err) {
        if (err.message === 'STOP_REASON_CLIENT_STREAM_ERROR') {
          log(`[retry] stream CLIENT_STREAM_ERROR — retrying non-agentic`);
          const cfg = buildCascadeConfig(resolvedModelId, { plannerConfig: { conversational: { agenticMode: false } } });
          const { text } = await sendMessage(items, cfg, null);
          sseChunk({ content: text });
        } else {
          res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        }
      }
      res.write('data: [DONE]\n\n'); res.end(); return;
    }

    // ── Non-streaming ────────────────────────────────────────────────────────
    const beforeSnap = await snapshotQuota();
    const t0 = Date.now();
    const { text, cascadeId, actions } = await sendMessage(items, cascadeConfig, existingCascadeId).catch(async err => {
      if (err.message === 'STOP_REASON_CLIENT_STREAM_ERROR') {
        log(`[retry] CLIENT_STREAM_ERROR — retrying with agenticMode:false`);
        return sendMessage(items, buildCascadeConfig(resolvedModelId, { plannerConfig: { conversational: { agenticMode: false } } }), null);
      }
      log('sendMessage failed, resetting context and retrying: ' + err.message);
      H2C = null; CTX = null; CTX = await discoverContext();
      return sendMessage(items, cascadeConfig, null);
    });

    if (sessionId) touchSession(sessionId, cascadeId, resolvedModelId);
    const latencyMs  = Date.now() - t0;
    const afterSnap  = await snapshotQuota();
    if (beforeSnap && afterSnap) {
      for (const label of Object.keys(afterSnap)) {
        recordRequest(label, afterSnap[label].planModel, {
          before: beforeSnap[label]?.remainingFraction ?? null, after: afterSnap[label].remainingFraction,
          promptChars, responseChars: text.length,
          latencyMs: afterSnap[label].planModel === resolvedModelInfo.planModel ? latencyMs : 0,
          resetTime: afterSnap[label].resetTime,
        });
      }
    }
    const modelSnap = afterSnap ? Object.values(afterSnap).find(s => s.planModel === resolvedModelInfo.planModel) : null;
    if (modelSnap?.remainingFraction != null) res.setHeader('x-ratelimit-remaining-fraction', `${(modelSnap.remainingFraction*100).toFixed(1)}%`);
    if (modelSnap?.resetTime != null)         res.setHeader('x-ratelimit-reset-tokens', modelSnap.resetTime);
    const hasActions = actions?.length > 0;
    return jsonResp(res, 200, {
      id: `cascade-${cascadeId}`, object: 'chat.completion',
      model: resolvedModelId,
      requested_model: resolvedModelId !== modelId ? modelId : undefined,
      session_id:  sessionId ?? undefined,
      tools_mode:  toolsMode,
      actions:     hasActions ? actions : undefined,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text, ...(hasActions ? { tool_calls: actions } : {}) },
        finish_reason: hasActions ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (err) {
    log('Error: ' + err.message);
    if (!res.headersSent) return jsonResp(res, 500, errBody(err.message));
  }
}

// ─── handleAdminRequest() — /sessions, /quota, /probe, /v1/models ─────────────

function humanTime(isoDate) {
  if (!isoDate) return null;
  const ms = new Date(isoDate) - Date.now();
  if (ms <= 0) return 'now';
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '<1m';
}

async function handleAdminRequest(path, method, body, res) {
  // GET /health
  if (method === 'GET' && path === '/health') {
    const ideRunning = (() => {
      try { return !!execSync('ps aux | grep language_server_macos_arm | grep -v grep').toString().trim(); }
      catch (_) { return false; }
    })();
    if (!ideRunning) return jsonResp(res, 503, { status: 'unavailable', ide: false, message: 'Antigravity is not running — please open the IDE' });
    try {
      if (!CTX) CTX = await discoverContext();
      return jsonResp(res, 200, { status: 'ok', ide: true, workspace: CTX.workspaceUri, port: CTX.port, transport: CTX.https ? 'HTTPS' : 'HTTP', defaultModel: DEFAULT_CASCADE_CONFIG.plannerConfig.planModel });
    } catch (err) {
      return jsonResp(res, 500, { status: 'error', ide: true, error: errBody(err.message).error });
    }
  }

  // GET /sessions
  if (method === 'GET' && path === '/sessions') {
    const list = [...sessions.entries()].map(([id, s]) => ({
      session_id: id, cascade_id: s.cascadeId, model: s.modelId,
      created_at:   new Date(s.createdAt).toISOString(),
      last_used_at: new Date(s.lastUsedAt).toISOString(),
      idle_for:     `${Math.round((Date.now()-s.lastUsedAt)/1000)}s`,
      messages:     s.messageCount,
    }));
    return jsonResp(res, 200, { sessions: list, count: list.length });
  }

  // DELETE /sessions/:id
  const delSession = path.match(/^\/sessions\/(.+)$/);
  if (method === 'DELETE' && delSession) {
    const id = delSession[1];
    if (sessions.has(id)) { sessions.delete(id); return jsonResp(res, 200, { ok: true, deleted: id }); }
    return jsonResp(res, 404, errBody('Session not found'));
  }

  // GET /v1/models
  if (method === 'GET' && path === '/v1/models') {
    try {
      if (!CTX) CTX = await discoverContext();
      const data        = await rpc('/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData', {});
      const configs     = data?.clientModelConfigs ?? [];
      const quotaByLabel = {};
      for (const c of configs) quotaByLabel[c.label] = c.quotaInfo ?? {};
      const models = Object.entries(MODELS).map(([id, info]) => {
        const quota     = quotaByLabel[info.label] ?? {};
        const resetTime = quota.resetTime ?? null;
        return { id, object: 'model', owned_by: 'antigravity', label: info.label, planModel: info.planModel, headless: info.headless,
          quota: { remainingFraction: quota.remainingFraction ?? null, remainingPct: quota.remainingFraction != null ? `${(quota.remainingFraction*100).toFixed(1)}%` : null, resetTime, refreshesIn: humanTime(resetTime) } };
      });
      return jsonResp(res, 200, { object: 'list', data: models });
    } catch (err) { return jsonResp(res, 500, errBody(err.message)); }
  }

  // GET /quota
  if (method === 'GET' && path === '/quota') {
    try {
      if (!CTX) CTX = await discoverContext();
      const snap = await snapshotQuota();
      const snapByLabel = snap ?? {};
      const data = Object.entries(MODELS).filter(([, m]) => m.headless).map(([id, m]) => {
        const s        = snapByLabel[m.label] ?? {};
        const t        = quotaTracker[m.label] ?? {};
        const requests = t.requests ?? 0;
        const pChars   = t.promptCharsTotal   ?? 0;
        const rChars   = t.responseCharsTotal ?? 0;
        const avgLatencyMs = requests > 0 ? Math.round(t.totalLatencyMs / requests) : null;
        const remaining    = s.remainingFraction ?? null;
        const resetTime    = s.resetTime ?? null;
        return {
          model: `google/${id}`, label: m.label,
          rate_limits: {
            limit_requests:     'NOT_SUPPORTED',
            remaining_requests: 'NOT_SUPPORTED',
            reset_requests:     'NOT_SUPPORTED',
            limit_tokens:       'NOT_SUPPORTED',
            remaining_tokens:   'NOT_SUPPORTED',
            reset_tokens:       resetTime ?? 'NOT_SUPPORTED',
          },
          provider_quota: {
            remaining_fraction: remaining ?? 'NOT_SUPPORTED',
            remaining_pct:      remaining != null ? `${(remaining*100).toFixed(1)}%` : 'NOT_SUPPORTED',
            reset_at:           resetTime ?? 'NOT_SUPPORTED',
          },
          session_usage: {
            requests,
            prompt_tokens:         'NOT_SUPPORTED',
            completion_tokens:     'NOT_SUPPORTED',
            total_tokens:          'NOT_SUPPORTED',
            prompt_tokens_est:     Math.round(pChars / 4),
            completion_tokens_est: Math.round(rChars / 4),
            total_tokens_est:      Math.round((pChars + rChars) / 4),
            avg_latency_ms:        avgLatencyMs,
          },
        };
      });
      return jsonResp(res, 200, { object: 'list', data });
    } catch (err) { return jsonResp(res, 500, errBody(err.message)); }
  }

  // POST /probe
  if (method === 'POST' && path === '/probe') {
    try {
      if (!CTX) CTX = await discoverContext();
      const { method: rpcMethod, body: rpcBody } = body;
      const result = await rpc(`/exa.language_server_pb.LanguageServerService/${rpcMethod}`, rpcBody ?? {});
      return jsonResp(res, 200, { ok: true, result });
    } catch (err) { return jsonResp(res, 500, { ok: false, error: errBody(err.message).error }); }
  }

  jsonResp(res, 404, errBody(`Unknown admin endpoint: ${method} ${path}`));
}

// ─── Backend interface ────────────────────────────────────────────────────────

module.exports = {
  id:     'antigravity',
  prefix: 'google',

  async init() {
    log('Antigravity backend initialising...');
    try {
      CTX = await discoverContext();
      log(`Ready — port ${CTX.port} ${CTX.https ? 'HTTPS' : 'HTTP'}`);
    } catch (e) {
      log('WARNING: ' + e.message + ' (will retry on first request)');
    }
  },

  async models() {
    return Object.entries(MODELS)
      .filter(([, m]) => m.headless)
      .map(([id, m]) => ({ id, label: m.label }));
  },

  async health() {
    const ideRunning = (() => {
      try { return !!execSync('ps aux | grep language_server_macos_arm | grep -v grep').toString().trim(); }
      catch (_) { return false; }
    })();
    if (!ideRunning) return { status: 'unavailable', ide: false };
    if (!CTX) {
      try { CTX = await discoverContext(); }
      catch (e) { return { status: 'error', ide: true, error: e.message }; }
    }
    return { status: 'ok', ide: true, workspace: CTX.workspaceUri, port: CTX.port, transport: CTX.https ? 'HTTPS' : 'HTTP' };
  },

  complete,
  handleAdminRequest,
};
