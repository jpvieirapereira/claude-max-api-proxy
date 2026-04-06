# Claude Max API Proxy

> Actively maintained fork of [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy) with OpenClaw integration, improved streaming, and expanded model support.

**Use your Claude Max subscription ($200/month) with any OpenAI-compatible client — no separate API costs!**

This proxy wraps the Claude Code CLI as a subprocess and exposes an OpenAI-compatible HTTP API, allowing tools like OpenClaw, Continue.dev, or any OpenAI-compatible client to use your Claude Max subscription instead of paying per-API-call.

## Why This Exists

| Approach | Cost | Limitation |
|----------|------|------------|
| Claude API | ~$15/M input, ~$75/M output tokens | Pay per use |
| Claude Max | $200/month flat | OAuth blocked for third-party API use |
| **This Proxy** | $0 extra (uses Max subscription) | Routes through CLI |

Anthropic blocks OAuth tokens from being used directly with third-party API clients. However, the Claude Code CLI *can* use OAuth tokens. This proxy bridges that gap by wrapping the CLI and exposing a standard API.

## How It Works

```
Your App (OpenClaw, Continue.dev, etc.)
         ↓
    HTTP Request (OpenAI format)
         ↓
   Claude Max API Proxy (this project)
         ↓
   Claude Code CLI (subprocess)
         ↓
   OAuth Token (from Max subscription)
         ↓
   Anthropic API
         ↓
   Response → OpenAI format → Your App
```

## Features

- **1M token context** — Supports Opus 4.6 with full 1M token context window
- **OpenAI-compatible API** — Works with any client that supports OpenAI's API format
- **Streaming with heartbeat** — SSE with 15s heartbeat to prevent timeouts on long requests
- **Session persistence** — Maintains real CLI sessions via `--resume` (not stateless)
- **Per-agent queue** — FIFO queue per agent key with global concurrency ceiling
- **Agent key derivation** — Deterministic identity from system prompt + model (djb2 hash)
- **OpenClaw gateway sync** — WebSocket integration for session state changes
- **OpenClaw tool mapping** — Automatic tool name mapping and system prompt adaptation
- **Multiple models** — Claude Opus 4.6, Sonnet 4.6, and Haiku 4.5
- **Auto-start service** — Optional LaunchAgent for macOS
- **Robust process management** — SIGKILL escalation, configurable timeouts, backpressure handling
- **Secure by design** — Uses `spawn()` to prevent shell injection

## What's Different from the Original

- **OpenClaw tool mapping** — Maps OpenClaw tool names (`exec`, `read`, `web_search`, etc.) to Claude Code equivalents (`Bash`, `Read`, `WebSearch`)
- **System prompt stripping** — Removes OpenClaw-specific tooling sections that confuse the CLI
- **Content block support** — Handles `input_text` content blocks and multi-block text separators
- **Tool call types** — Full OpenAI tool call type definitions for streaming and non-streaming
- **Improved streaming** — Better SSE handling with connection confirmation and client disconnect detection

## Prerequisites

1. **Claude Max subscription** ($200/month) — [Subscribe here](https://claude.ai)
2. **Claude Code CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```

## Installation

```bash
# Clone the repository
git clone https://github.com/wende/claude-max-api-proxy.git
cd claude-max-api-proxy

# Install dependencies
npm install

# Build
npm run build
```

## Usage

### Start the server

```bash
npm start
# or
node dist/server/standalone.js
```

The server runs at `http://localhost:3456` by default. Pass a custom port as an argument:

```bash
node dist/server/standalone.js 8080
```

### Test it

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion (non-streaming)
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Chat completion (streaming)
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |

## Available Models

| Model ID | Alias | Context Window | Max Output |
|----------|-------|---------------|------------|
| `claude-opus-4-6` | `opus` | 1,000,000 | 32,768 |
| `claude-sonnet-4-6` | `sonnet` | 1,000,000 | 32,768 |
| `claude-haiku-4-5` | `haiku` | 1,000,000 | 32,768 |

All model IDs also accept a `claude-code-cli/` or `claude-max/` prefix. Unknown models default to Opus.

## Configuration with Popular Tools

### OpenClaw

OpenClaw works with this proxy out of the box. The proxy automatically maps OpenClaw tool names to Claude Code equivalents and strips conflicting tooling sections from system prompts.

### Continue.dev

Add to your Continue config:

```json
{
  "models": [{
    "title": "Claude (Max)",
    "provider": "openai",
    "model": "claude-sonnet-4",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

### Generic OpenAI Client (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="not-needed"  # Any value works
)

response = client.chat.completions.create(
    model="claude-sonnet-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_BIN` | `claude` | Absolute path to the Claude CLI binary |
| `CLAUDE_TIMEOUT_MS` | `2700000` (45min) | Subprocess timeout in milliseconds |
| `CLAUDE_MAX_CONCURRENT` | `3` | Max simultaneous CLI processes across all agents |
| `CLAUDE_MAX_QUEUE_PER_AGENT` | `5` | Max queued requests per agent |
| `CLAUDE_QUEUE_WAIT_MS` | `60000` (60s) | Max wait time in agent queue before 429 |
| `DEBUG` | — | Enable request logging |
| `DEBUG_SUBPROCESS` | — | Enable subprocess debug logging |

## OpenClaw Gateway Sync

If `~/.openclaw/openclaw.json` exists with gateway config, the proxy connects via WebSocket for passive session state sync. When OpenClaw resets or deletes a session, the proxy invalidates its local session automatically.

Works without gateway — graceful degradation.

## Auto-Start on macOS

The proxy can run as a macOS LaunchAgent on port 3456.

**Plist location:** `~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist`

```bash
# Start the service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist

# Restart
launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-max-proxy

# Stop
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy

# Check status
launchctl list com.openclaw.claude-max-proxy
```

## Architecture

```
src/
├── types/
│   ├── claude-cli.ts      # Claude CLI JSON streaming types + type guards
│   └── openai.ts          # OpenAI API types (including tool calls)
├── adapter/
│   ├── openai-to-cli.ts   # Convert OpenAI requests → CLI format + agent key derivation
│   └── cli-to-openai.ts   # Convert CLI responses → OpenAI format
├── subprocess/
│   ├── manager.ts         # Claude CLI subprocess (StringDecoder, backpressure, SIGKILL)
│   └── queue.ts           # Per-agent FIFO concurrency queue
├── session/
│   ├── manager.ts         # Session mapping + invalidation
│   └── gateway-sync.ts    # WebSocket sync with OpenClaw gateway
├── server/
│   ├── index.ts           # Express server setup + gateway init
│   ├── routes.ts          # API route handlers (SSE heartbeat, per-agent queue)
│   └── standalone.ts      # Entry point
└── index.ts               # Package exports
```

## Security

- Uses Node.js `spawn()` instead of shell execution to prevent injection attacks
- No API keys stored or transmitted by this proxy
- All authentication handled by Claude CLI's secure keychain storage
- Prompts passed as CLI arguments, not through shell interpretation

## Troubleshooting

### "Claude CLI not found" or ENOTDIR error

Install and authenticate the CLI, then set `CLAUDE_BIN`:
```bash
npm install -g @anthropic-ai/claude-code
claude auth login
export CLAUDE_BIN=$(which claude)
```

### Streaming returns immediately with no content

Ensure you're using `-N` flag with curl (disables buffering):
```bash
curl -N -X POST http://localhost:3456/v1/chat/completions ...
```

### Connection drops on long requests

The proxy sends SSE heartbeat comments every 15s. If you have an intermediate proxy (nginx, HAProxy), ensure its timeout is longer than `CLAUDE_TIMEOUT_MS` (default 45min).

### Queue full (HTTP 429)

Increase concurrency or per-agent queue size:
```bash
CLAUDE_MAX_CONCURRENT=5 CLAUDE_MAX_QUEUE_PER_AGENT=10 npm start
```

## Contributing

Contributions welcome! Please submit PRs with tests.

## License

MIT

## Acknowledgments

- Originally created by [atalovesyou](https://github.com/atalovesyou/claude-max-api-proxy)
- Built for use with [OpenClaw](https://openclaw.com)
- Powered by [Claude Code CLI](https://github.com/anthropics/claude-code)
