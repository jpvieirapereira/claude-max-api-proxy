/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { acquire, queueStats } from "../subprocess/queue.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import { sessionManager } from "../session/manager.js";
import {
  cliResultToOpenai,
  createDoneChunk,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest, OpenAIToolCall } from "../types/openai.js";
import type { ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    // Convert to CLI input format
    const cliInput = openaiToCli(body);

    // Use session manager to determine if this agent already has a CLI session.
    // This is the source of truth — NOT the message count.
    // Via Telegram, OpenClaw may send only 1 user message without history,
    // but the CLI session already exists from a previous request.
    const existingSession = sessionManager.get(cliInput.agentKey);
    if (existingSession) {
      // Resume existing session — override adapter's detection.
      // CRITICAL: always use resumePrompt (last user message only).
      // The adapter may have detected a "new session" (e.g. OpenClaw sent
      // only 1 user message via Telegram) and set prompt to the full
      // messagesToPrompt output with <system> tags. Sending that to a
      // --resume session would inject the system prompt again as user
      // content, confusing Claude and making it appear to restart.
      cliInput.isNewSession = false;
      cliInput.sessionId = existingSession.claudeSessionId;
      cliInput.prompt = cliInput.resumePrompt;
      cliInput.systemPrompt = undefined; // CLI already has it
      console.log(`[Route] Resuming session for agent ${cliInput.agentKey} → ${existingSession.claudeSessionId}`);
    } else {
      // No existing CLI session — create one and register in session manager.
      const claudeSessionId = sessionManager.getOrCreate(cliInput.agentKey, cliInput.model);
      cliInput.sessionId = claudeSessionId;
      cliInput.isNewSession = true;

      // CRITICAL FIX: The adapter may have detected a continuation (multiple
      // messages) and set prompt to only the last user message. But since no
      // CLI session exists, we MUST send the full conversation context so
      // Claude doesn't lose history. Without this, large-context requests
      // appear to "restart" the conversation.
      cliInput.prompt = cliInput.fullPrompt;
      cliInput.systemPrompt = cliInput.fullSystemPrompt;

      console.log(`[Route] New session for agent ${cliInput.agentKey} → ${claudeSessionId}`);
    }

    // Wait for a per-agent concurrency slot
    let release: () => void;
    try {
      release = await acquire(cliInput.agentKey);
    } catch (queueErr) {
      // Queue full or timeout — return 429
      res.status(429).json({
        error: {
          message: queueErr instanceof Error ? queueErr.message : "Queue full",
          type: "rate_limit_error",
          code: "queue_full",
        },
      });
      return;
    }

    try {
      const subprocess = new ClaudeSubprocess();
      if (stream) {
        await handleStreamingResponse(req, res, subprocess, cliInput, requestId);
      } else {
        await handleNonStreamingResponse(res, subprocess, cliInput, requestId);
      }
    } finally {
      release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Convert Claude tool_use ID to OpenAI-compatible call ID.
 * Claude uses "toolu_abc123", OpenAI uses "call_abc123".
 */
function toOpenAICallId(claudeId: string): string {
  return `call_${claudeId.replace("toolu_", "")}`;
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // CRITICAL: Flush headers immediately to establish SSE connection
  // Without this, headers are buffered and client times out waiting
  res.flushHeaders();

  // Send initial comment to confirm connection is alive
  res.write(":ok\n\n");

  return new Promise<void>((resolve) => {
    let isFirst = true;
    let lastModel = "claude-opus-4-6";
    let isComplete = false;
    let hasEmittedText = false;
    let resolved = false;

    const done = () => {
      if (!resolved) {
        resolved = true;
        clearInterval(heartbeatId);
        resolve();
      }
    };

    // SSE heartbeat: send comment every 15s to keep connection alive
    // during long-running 1M token processing (prevents proxy/client timeouts)
    const heartbeatId = setInterval(() => {
      if (!res.writableEnded) {
        res.write(":heartbeat\n\n");
      } else {
        clearInterval(heartbeatId);
      }
    }, 15_000);

    // Handle actual client disconnect (response stream closed)
    res.on("close", () => {
      if (!isComplete) {
        // Client disconnected before response completed - kill subprocess
        subprocess.kill();
      }
      done();
    });

    // When a new text content block starts after we've already emitted text,
    // insert a separator so text from different blocks doesn't run together
    subprocess.on("text_block_start", () => {
      if (hasEmittedText && !res.writableEnded) {
        const sepChunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              content: "\n\n",
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(sepChunk)}\n\n`);
      }
    });

    // Handle streaming content deltas
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const delta = event.event.delta;
      const text = (delta?.type === "text_delta" && delta.text) || "";
      if (text && !res.writableEnded) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              role: isFirst ? "assistant" : undefined,
              content: text,
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
        hasEmittedText = true;
      }
    });

    // DISABLED: Tool call forwarding causes an agentic loop — OpenClaw interprets
    // Claude Code's internal tool_use (Read, Bash, etc.) as calls it needs to
    // handle, triggering repeated requests. Claude Code handles tools internally
    // via --print mode; only the final text result should be forwarded.
    // TODO: Re-enable with a non-tool_calls display mechanism (e.g. inline text).
    //
    // subprocess.on("tool_use_start", (event: ClaudeCliStreamEvent) => {
    //   if (res.writableEnded) return;
    //   const block = event.event.content_block;
    //   if (block?.type !== "tool_use") return;
    //
    //   inToolBlock = true;
    //   const chunk = {
    //     id: `chatcmpl-${requestId}`,
    //     object: "chat.completion.chunk",
    //     created: Math.floor(Date.now() / 1000),
    //     model: lastModel,
    //     choices: [{
    //       index: 0,
    //       delta: {
    //         role: isFirst ? "assistant" : undefined,
    //         tool_calls: [{
    //           index: toolCallIndex,
    //           id: toOpenAICallId(block.id),
    //           type: "function" as const,
    //           function: {
    //             name: block.name,
    //             arguments: "",
    //           },
    //         }],
    //       },
    //       finish_reason: null,
    //     }],
    //   };
    //   res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    //   isFirst = false;
    // });
    //
    // subprocess.on("input_json_delta", (event: ClaudeCliStreamEvent) => {
    //   if (res.writableEnded) return;
    //   const delta = event.event.delta;
    //   if (delta?.type !== "input_json_delta") return;
    //
    //   const chunk = {
    //     id: `chatcmpl-${requestId}`,
    //     object: "chat.completion.chunk",
    //     created: Math.floor(Date.now() / 1000),
    //     model: lastModel,
    //     choices: [{
    //       index: 0,
    //       delta: {
    //         tool_calls: [{
    //           index: toolCallIndex,
    //           function: {
    //             arguments: delta.partial_json,
    //           },
    //         }],
    //       },
    //       finish_reason: null,
    //     }],
    //   };
    //   res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    // });
    //
    // subprocess.on("content_block_stop", () => {
    //   if (inToolBlock) {
    //     toolCallIndex++;
    //     inToolBlock = false;
    //   }
    // });

    // Handle final assistant message (for model name)
    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      lastModel = message.message.model;
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;

      // Detect CLI-level errors (auth failures, permission errors, etc.)
      if (result.is_error && !res.writableEnded) {
        const errMsg = result.result || "Claude CLI returned an error";
        const isAuthError = /not logged in|please run \/login|auth|unauthorized/i.test(errMsg);
        console.error(`[Streaming] CLI error result: ${errMsg.slice(0, 300)}`);

        // Invalidate the session so it's not reused in a broken state
        if (cliInput.sessionId) {
          sessionManager.invalidateByClaudeSessionId(cliInput.sessionId);
        }

        res.write(`data: ${JSON.stringify({
          error: {
            message: isAuthError
              ? `Claude CLI auth error: ${errMsg}. Run "claude auth login" on the server.`
              : `Claude CLI error: ${errMsg}`,
            type: isAuthError ? "authentication_error" : "server_error",
            code: isAuthError ? "not_authenticated" : null,
          },
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        done();
        return;
      }

      if (!res.writableEnded) {
        // Send final done chunk with finish_reason and usage data
        const doneChunk = createDoneChunk(requestId, lastModel);
        if (result.usage) {
          doneChunk.usage = {
            prompt_tokens: result.usage.input_tokens || 0,
            completion_tokens: result.usage.output_tokens || 0,
            total_tokens:
              (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0),
          };
        }
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      done();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      done();
    });

    subprocess.on("close", (code: number | null) => {
      // Subprocess exited - ensure response is closed
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          // Abnormal exit without result - send error
          res.write(`data: ${JSON.stringify({
            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
          })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      done();
    });

    // Start the subprocess
    subprocess.start(cliInput.prompt, {
      model: cliInput.model,
      sessionId: cliInput.sessionId,
      isNewSession: cliInput.isNewSession,
      systemPrompt: cliInput.systemPrompt,
    }).catch((err) => {
      console.error("[Streaming] Subprocess start error:", err);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: err.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      done();
    });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;
    // DISABLED: see tool call forwarding comment in handleStreamingResponse
    // const accumulatedToolCalls: OpenAIToolCall[] = [];
    //
    // subprocess.on("assistant", (message: ClaudeCliAssistant) => {
    //   for (const block of message.message.content) {
    //     if (block.type === "tool_use") {
    //       accumulatedToolCalls.push({
    //         id: toOpenAICallId(block.id),
    //         type: "function",
    //         function: {
    //           name: block.name,
    //           arguments: JSON.stringify(block.input),
    //         },
    //       });
    //     }
    //   }
    // });

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
      console.log(`[NonStreaming] Result: is_error=${result.is_error} subtype=${result.subtype} result_len=${result.result?.length ?? 'null'} result_preview="${(result.result || '').slice(0, 200)}"`);
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (finalResult && finalResult.is_error) {
        // CLI returned an error result — don't forward as content
        const errMsg = finalResult.result || "Claude CLI returned an error";
        const isAuthError = /not logged in|please run \/login|auth|unauthorized/i.test(errMsg);
        console.error(`[NonStreaming] CLI error result: ${errMsg.slice(0, 300)}`);

        // Invalidate the session so it's not reused in a broken state
        if (cliInput.sessionId) {
          sessionManager.invalidateByClaudeSessionId(cliInput.sessionId);
        }

        if (!res.headersSent) {
          res.status(isAuthError ? 401 : 502).json({
            error: {
              message: isAuthError
                ? `Claude CLI auth error: ${errMsg}. Run "claude auth login" on the server.`
                : `Claude CLI error: ${errMsg}`,
              type: isAuthError ? "authentication_error" : "server_error",
              code: isAuthError ? "not_authenticated" : null,
            },
          });
        }
      } else if (finalResult) {
        res.json(cliResultToOpenai(finalResult, requestId));
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    // Start the subprocess
    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
      })
      .catch((error) => {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
        resolve();
      });
  });
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req: Request, res: Response): void {
  const now = Math.floor(Date.now() / 1000);
  const models = [
    { id: "claude-opus-4-6", context_length: 1000000 },
    { id: "claude-sonnet-4-6", context_length: 1000000 },
    { id: "claude-haiku-4-5", context_length: 1000000 },
  ];
  res.json({
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      owned_by: "anthropic",
      created: now,
      context_length: m.context_length,
    })),
  });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    queue: queueStats(),
    timestamp: new Date().toISOString(),
  });
}
