'use strict';

/**
 * Router — model registry and request dispatch.
 *
 * At startup, queries each backend for its model list and builds a registry:
 *   Map<"claude/sonnet", { backend, bareModel: "sonnet" }>
 *
 * On each request, looks up the model, strips the provider prefix, and calls
 * backend.complete(body, res).
 */

const backends  = [];                 // registered backend drivers
const registry  = new Map();         // prefixed model id → { backend, bareModel }

// ─── Registration ─────────────────────────────────────────────────────────────

function register(backend) {
  backends.push(backend);
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function init() {
  for (const backend of backends) {
    try {
      await backend.init();
      const models = await backend.models();
      for (const m of models) {
        const prefixed = `${backend.prefix}/${m.id}`;
        registry.set(prefixed, { backend, bareModel: m.id });
        // Also register bare name as fallback (e.g. "sonnet" → anthropic)
        // Bare name is only registered once — first backend that claims it wins.
        if (!registry.has(m.id)) registry.set(m.id, { backend, bareModel: m.id });
      }
      console.log(`[router] ${backend.id}: registered ${models.length} model(s)`);
    } catch (err) {
      console.log(`[router] WARNING: ${backend.id} init failed — ${err.message}`);
    }
  }
  console.log(`[router] Registry: ${[...registry.keys()].join(', ')}`);
}

// ─── Routing ──────────────────────────────────────────────────────────────────

/**
 * Route a POST /v1/chat/completions request.
 * Resolves the model, strips the provider prefix, calls backend.complete(body, res).
 */
async function route(body, res) {
  const rawModel = body.model;

  // Direct registry lookup (handles "claude/sonnet", "google/gemini-flash", bare aliases)
  let entry = registry.get(rawModel);

  // Prefix-based fallback: if "claude/unknown-model", route to the claude backend anyway
  if (!entry && rawModel) {
    const slashIdx = rawModel.indexOf('/');
    if (slashIdx !== -1) {
      const prefix = rawModel.slice(0, slashIdx);
      const bare   = rawModel.slice(slashIdx + 1);
      const backend = backends.find(b => b.prefix === prefix);
      if (backend) entry = { backend, bareModel: bare };
    }
  }

  if (!entry) {
    const known = [...registry.keys()].filter(k => k.includes('/')).join(', ');
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(400);
    res.end(JSON.stringify({ error: { message: `Unknown model "${rawModel}". Available: ${known}`, type: 'invalid_request_error', code: null } }));
    return;
  }

  // Forward with bare model name (no prefix)
  body.model = entry.bareModel;
  return entry.backend.complete(body, res);
}

// ─── /v1/models — combined list from all backends ────────────────────────────

async function listModels() {
  const all = [];
  for (const backend of backends) {
    try {
      const models = await backend.models();
      for (const m of models) {
        all.push({ id: `${backend.prefix}/${m.id}`, object: 'model', owned_by: backend.id, label: m.label });
      }
    } catch (_) {}
  }
  return { object: 'list', data: all };
}

// ─── /health — aggregate from all backends ────────────────────────────────────

async function healthAll() {
  const result = {};
  let allOk = true;
  for (const backend of backends) {
    try {
      result[backend.id] = await backend.health();
      if (result[backend.id].status !== 'ok') allOk = false;
    } catch (err) {
      result[backend.id] = { status: 'error', error: err.message };
      allOk = false;
    }
  }
  return { status: allOk ? 'ok' : 'degraded', backends: result };
}

// ─── Admin request dispatch ───────────────────────────────────────────────────

/**
 * Route backend-specific admin requests.
 * backendId: 'anthropic' | 'antigravity'  (matches backend.id)
 */
async function routeAdmin(backendId, path, method, body, res) {
  const backend = backends.find(b => b.id === backendId);
  if (!backend) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: `Unknown backend: ${backendId}`, type: 'invalid_request_error', code: null } }));
    return;
  }
  return backend.handleAdminRequest(path, method, body, res);
}

module.exports = { register, init, route, listModels, healthAll, routeAdmin };
