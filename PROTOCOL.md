# Claude Code CLI JSON Streaming Protocol

Research findings for Task #1.

## CLI Flags for Programmatic Use

```bash
claude --print \
  --output-format stream-json \
  --input-format stream-json \
  --verbose \
  --include-partial-messages \
  --model <opus|sonnet|haiku> \
  --session-id <uuid> \
  --resume <session-id>
```

### Key Flags

| Flag | Description |
|------|-------------|
| `--print` | Non-interactive mode, required for piping |
| `--output-format stream-json` | JSON line output (requires `--verbose`) |
| `--input-format stream-json` | JSON line input for messages |
| `--verbose` | Required for stream-json output |
| `--include-partial-messages` | Get streaming chunks as they arrive |
| `--session-id <uuid>` | Use specific session ID |
| `--resume <id>` | Resume existing conversation |
| `--model <alias>` | Model: opus, sonnet, haiku |
| `--no-session-persistence` | Don't save sessions to disk |

## Output Message Types

### 1. System Init (`type: "system", subtype: "init"`)

Sent at session start with full context:

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/Users/atal/Desktop/ClaudeTest",
  "session_id": "72db4887-c10b-4445-89fa-26e4fc184df9",
  "tools": ["Task", "Bash", "Read", "Edit", ...],
  "mcp_servers": [...],
  "model": "claude-sonnet-4-5-20250929",
  "permissionMode": "bypassPermissions",
  "slash_commands": [...],
  "skills": [...],
  "plugins": [...],
  "uuid": "1121b09e-d912-4fd7-91b6-ff72a513e8e4"
}
```

### 2. Hook Messages (`type: "system", subtype: "hook_*"`)

```json
{
  "type": "system",
  "subtype": "hook_started",
  "hook_id": "...",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "session_id": "..."
}
```

```json
{
  "type": "system",
  "subtype": "hook_response",
  "hook_id": "...",
  "output": "...",
  "exit_code": 0,
  "outcome": "success"
}
```

### 3. Assistant Message (`type: "assistant"`)

Contains model response:

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-sonnet-4-5-20250929",
    "id": "msg_01Avr9xkb5daf79U5oDRrHQ9",
    "type": "message",
    "role": "assistant",
    "content": [
      {"type": "text", "text": "Hello!"}
    ],
    "stop_reason": null,
    "usage": {
      "input_tokens": 2,
      "output_tokens": 1,
      "cache_creation_input_tokens": 42255
    }
  },
  "session_id": "...",
  "uuid": "..."
}
```

### 4. Result Message (`type: "result"`)

Final message with stats:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 3613,
  "duration_api_ms": 5187,
  "num_turns": 1,
  "result": "The final text response",
  "session_id": "72db4887-c10b-4445-89fa-26e4fc184df9",
  "total_cost_usd": 0.15939125,
  "usage": {
    "input_tokens": 2,
    "output_tokens": 13,
    "cache_creation_input_tokens": 42255,
    "cache_read_input_tokens": 0
  },
  "modelUsage": {
    "claude-sonnet-4-5-20250929": {
      "inputTokens": 2,
      "outputTokens": 13,
      "costUSD": 0.15865725
    }
  }
}
```

## Input Format (stream-json)

When using `--input-format stream-json`, send JSON lines to stdin:

```json
{"type": "user_message", "content": "Hello, how are you?"}
```

**TODO:** Need to verify exact input format with testing.

## Session Management

- Sessions are identified by UUID
- **New session**: `--session-id <uuid>` creates a new persistent session
- **Resume session**: `--resume <uuid>` continues an existing session with full CLI history
- Sessions persist on disk by default (the proxy relies on this for conversation continuity)
- `--no-session-persistence` disables persistence (used for stateless/one-shot requests only)

### Agent Key Derivation

The proxy derives a deterministic agent key from the system prompt + model using djb2 hash:
```
agent-{djb2(first_200_chars_of_system_prompt + "|" + model)}
```
This ensures the same OpenClaw agent always maps to the same CLI session.

## Important Notes

1. **OAuth Token Usage**: Claude CLI uses the logged-in user's OAuth token automatically
2. **Cost Tracking**: Each response includes `total_cost_usd` — subscription usage, not API billing
3. **Tools**: Claude Code tools (Bash, Read, Edit, etc.) are mapped from OpenClaw names via `--append-system-prompt`
4. **Streaming**: With `--include-partial-messages`, get real-time chunks
5. **SSE Heartbeat**: Proxy sends `:heartbeat\n\n` every 15s to keep connections alive during long processing
6. **1M Token Context**: Body parser supports 200MB payloads; subprocess uses StringDecoder for safe UTF-8 and stdin backpressure
7. **Timeout**: Default 45min (`CLAUDE_TIMEOUT_MS`), with SIGKILL escalation 5s after SIGTERM
8. **Per-Agent Queue**: Each agent key gets a serialized FIFO queue; global ceiling of `CLAUDE_MAX_CONCURRENT` processes

## Message Flow for Clawdbot Integration

```
Clawdbot User Message
        │
        ▼
┌───────────────────────────┐
│ Format as JSON input      │
│ {"type":"user_message"..} │
└───────────────────────────┘
        │
        ▼ (stdin)
┌───────────────────────────┐
│   Claude Code CLI         │
│   (subprocess)            │
└───────────────────────────┘
        │
        ▼ (stdout - JSON lines)
┌───────────────────────────┐
│ Parse JSON stream         │
│ - Filter system messages  │
│ - Extract assistant text  │
│ - Capture result stats    │
└───────────────────────────┘
        │
        ▼
Clawdbot Response to User
```
