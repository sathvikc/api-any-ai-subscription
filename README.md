# Convert and Use any AI Subscription as OpenAI API compatible endpoint

A lightweight bridge that turns personal AI subscriptions into a single OpenAI-compatible API endpoint — one server, multiple backends, drop-in replacement for any OpenAI SDK.

> **Why this exists**
> Monthly AI subscriptions + per-token API keys add up fast during local development. This lets you reuse subscriptions you already pay for as a local API endpoint while building and experimenting.

> **Intended use**: Personal development and testing only. Not for commercial use or production deployment. Use at your own risk.

## Demo

### Antigravity
[https://github.com/sathvikc/api-any-ai-subscription/raw/main/assets/API_WITH_ANTIGRAVITY.mp4](https://github.com/user-attachments/assets/463d7a3c-04be-4b26-8e7a-c2c3e37659c1)

### Claude
[https://github.com/sathvikc/api-any-ai-subscription/raw/main/assets/API_WITH_CLAUDE.mp4](https://github.com/user-attachments/assets/65dbe592-fab6-48b9-afcc-538641f1c55b)


## Supported subscriptions

| Provider | Model prefix | Subscription needed |
|---|---|---|
| Anthropic (Claude) | `claude/*` | Claude Pro / Max via Claude Code CLI |
| Google (Antigravity) | `google/*` | Google Antigravity IDE |

**Coming soon:** GitHub Copilot support (`copilot/*`)

---

## Platform support

macOS only at this time — both backends rely on macOS-specific credential stores and binaries:
- Anthropic uses the **macOS Keychain** to read Claude Code OAuth tokens
- Antigravity discovers the language server via `ps` and `lsof`, and expects the `language_server_macos_arm` binary

Linux and Windows support is not implemented but contributions are welcome — see [Contributing](#contributing).

---

## How it works

A single server on port 9000 routes requests by model prefix:

```
POST /v1/chat/completions  { "model": "claude/haiku", ... }
                                     │
                              ┌──────┴──────┐
                              ▼             ▼
                        claude/*       google/*
                       Anthropic      Antigravity
                        backend        backend
```

Any OpenAI-compatible client works unchanged — point `base_url` at `http://localhost:9000/v1` and use the prefixed model name.

---

## Prerequisites

**Anthropic (`claude/*`):**
- macOS with [Claude Code CLI](https://claude.ai/code) installed and `claude login` run once
- Credentials are read from the macOS Keychain automatically — **Claude Code does not need to be running** for normal requests
- Tokens are refreshed automatically before expiry
- **Agentic mode only** (`"mode": "agentic"` in the request body): spawns `claude -p` subprocesses, so Claude Code must be installed and available in `PATH`

**Antigravity (`google/*`):**
- **Antigravity IDE must be actively running** with an open session — the bridge discovers the language server port automatically via `ps`/`lsof`
- The `language_server_macos_arm` process must be visible; if the IDE is closed, requests to `google/*` models will fail with an error

---

## Setup

```bash
npm install
npm start          # starts on http://localhost:9000
```

Override the port:
```bash
PORT=8080 npm start
```

---

## Endpoints

### `POST /v1/chat/completions`

Standard OpenAI chat completions. Supports streaming, tool use, system prompts, vision (Anthropic only), and session context.

```bash
# Basic
curl http://localhost:9000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude/haiku","messages":[{"role":"user","content":"Hello!"}]}'

# Streaming
curl http://localhost:9000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"google/gemini-flash","stream":true,"messages":[{"role":"user","content":"Count to 5."}]}'

# Session context (conversation persists across requests)
curl http://localhost:9000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude/haiku","session_id":"my-session","messages":[{"role":"user","content":"My name is Alice."}]}'
```

**Rate limit headers on every response** (populated when the provider gives the data):
```
x-ratelimit-reset-tokens         when the quota window resets
x-ratelimit-utilization-5h       Anthropic: 5-hour window utilization %
x-ratelimit-utilization-7d       Anthropic: 7-day window utilization %
x-ratelimit-remaining-fraction   Antigravity: remaining quota %
```

---

### `GET /v1/models`

Lists all available models across all running backends.

```bash
curl http://localhost:9000/v1/models
```

---

### `GET /health`

Aggregate health — `200` when all backends are healthy, `503` when degraded.

### `GET /status`

Server info and available endpoints.

---

## Backend admin routes

### Anthropic (`/anthropic/*`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/anthropic/health` | Token status, plan, expiry |
| GET | `/anthropic/sessions` | Active session list |
| DELETE | `/anthropic/sessions/:id` | Remove a session |
| GET | `/anthropic/workers` | Active Claude Code subprocess pool |
| DELETE | `/anthropic/workers/:key` | Kill a worker |
| GET | `/anthropic/quota` | Token usage and utilization per model |
| GET | `/anthropic/v1/models` | Model list with rate limit info |

### Antigravity (`/google/*`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/google/health` | IDE status, port, workspace |
| GET | `/google/sessions` | Active Cascade session list |
| DELETE | `/google/sessions/:id` | Remove a session |
| GET | `/google/quota` | Remaining quota per model |
| GET | `/google/v1/models` | Model list with quota info |
| POST | `/google/probe` | Raw RPC call for debugging |

---

## Quota

Both `/quota` endpoints return the same shape. Fields the provider does not expose are returned as `"NOT_SUPPORTED"`.

```json
{
  "object": "list",
  "data": [{
    "model": "claude/haiku",
    "label": "Claude Haiku 3.5",
    "rate_limits": {
      "limit_requests":     "NOT_SUPPORTED",
      "remaining_requests": "NOT_SUPPORTED",
      "reset_requests":     "NOT_SUPPORTED",
      "limit_tokens":       "NOT_SUPPORTED",
      "remaining_tokens":   "NOT_SUPPORTED",
      "reset_tokens":       "2026-03-29T20:00:00Z"
    },
    "provider_quota": {
      "util_5h":  "45.2%",
      "util_7d":  "12.1%",
      "reset_at": "2026-03-29T20:00:00Z"
    },
    "session_usage": {
      "requests":          5,
      "prompt_tokens":     1234,
      "completion_tokens": 567,
      "total_tokens":      1801,
      "avg_latency_ms":    1200
    }
  }]
}
```

Session usage resets on server restart — intentional for a stateless deployment model.

---

## Using with OpenAI SDKs

**Python:**
```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:9000/v1", api_key="not-needed")

response = client.chat.completions.create(
    model="claude/haiku",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

**Node.js:**
```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://localhost:9000/v1', apiKey: 'not-needed' });

const res = await client.chat.completions.create({
  model:    'google/gemini-flash',
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(res.choices[0].message.content);
```

---

## Tests

Requires the server running on port 9000 before starting.

```bash
npm start &

npm test                  # all tests
npm run test:anthropic    # Anthropic backend only
npm run test:antigravity  # Antigravity backend only (requires IDE running)
npm run test:router       # routing and combined endpoints
npm run test:fast         # skip slow/agentic tests
npm run test:slow         # only slow/agentic tests
```

Filter by name:
```bash
npm run test:anthropic -- -t "streaming"
npm run test:anthropic -- -t "tool use"
```

Antigravity tests skip gracefully when the IDE is not running.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  server.js  :9000                   │
│                                                     │
│  POST /v1/chat/completions  →  router.route()       │
│  GET  /v1/models            →  router.listModels()  │
│  GET  /health               →  router.healthAll()   │
│  ANY  /anthropic/*          →  anthropic backend    │
│  ANY  /google/*             →  antigravity backend  │
└──────────────────┬──────────────────────────────────┘
                   │
         ┌─────────┴──────────┐
         ▼                    ▼
┌─────────────────┐  ┌──────────────────────┐
│ anthropic.js    │  │ antigravity.js       │
│ claude/* prefix │  │ google/* prefix      │
│ OAuth Keychain  │  │ H2C / Cascade RPC    │
│ Token refresh   │  │ Port auto-discovery  │
│ Worker pool     │  │ Cascade sessions     │
└─────────────────┘  └──────────────────────┘
```

Adding a new backend is a single file:
```js
module.exports = {
  id:     'provider',
  prefix: 'myprefix',
  async init()   { },
  async models() { return [{ id: 'model-name', label: 'Display Name' }]; },
  async health() { return { status: 'ok' }; },
  async complete(body, res) { },
  async handleAdminRequest(path, method, body, res) { },
};
```

Register in `server.js`:
```js
router.register(require('./backends/myprovider'));
```

---

## Limitations

- **macOS only** — Keychain integration and `language_server_macos_arm` binary are macOS-specific
- **Personal subscriptions only** — designed for individual developer use; not tested with team/enterprise plans
- **Session state is in-memory** — resets on server restart; no persistence layer
- **Antigravity token counts are estimated** — the Cascade protocol does not return exact token counts; prompt/completion tokens are approximated from character counts (`chars / 4`)
- **Streaming quota tracking** — Antigravity quota snapshots are taken after the stream ends, so `before` deltas are not available for streaming requests
- **No auth on the local server** — the bridge listens on `127.0.0.1` only; do not expose it to a network

---

## Roadmap

- GitHub Copilot backend (`copilot/*`)
- Linux and Windows support
- Antigravity utilization headers (once the language server exposes them)
- Per-session token usage tracking

---

## Contributing

Contributions are welcome, especially:
- **Other OS support** — Linux (`~/.config/` credential paths, different binary names) and Windows
- **New backends** — any subscription-based AI service that can be bridged
- **Bug fixes and tests**

To add a new backend, implement the interface described in [Architecture](#architecture) above and open a PR.

Please keep changes focused — one feature or fix per PR. For large changes, open an issue first to discuss the approach.

---

## License

MIT

Personal use and testing only. The author is not responsible for any misuse or account actions taken by underlying AI providers.
