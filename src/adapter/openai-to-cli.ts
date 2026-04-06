/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import type { OpenAIChatRequest, OpenAIContentBlock } from "../types/openai.js";

export type ClaudeModel = "opus" | "sonnet" | "haiku";

export interface CliInput {
  /** Prompt to send — picked by routes.ts based on session state */
  prompt: string;
  /** Full conversation context (for new sessions that need full history) */
  fullPrompt: string;
  /** Just the last user message (for resumed sessions where CLI has history) */
  resumePrompt: string;
  systemPrompt?: string;
  /** Full system prompt (for new sessions that need it) */
  fullSystemPrompt?: string;
  model: ClaudeModel;
  agentKey: string;
  sessionId?: string;
  isNewSession: boolean;
}

const MODEL_MAP: Record<string, ClaudeModel> = {
  // Direct model names (provider prefixes like `claude-code-cli/` and `claude-max/`
  // are stripped by extractModel before consulting this map)
  "claude-opus-4-6": "opus",
  "claude-sonnet-4-6": "sonnet",
  "claude-haiku-4-5": "haiku",
  // Bare aliases
  "opus": "opus",
  "sonnet": "sonnet",
  "haiku": "haiku",
  "opus-max": "opus",
  "sonnet-max": "sonnet",
};

/**
 * Extract Claude model alias from request model string
 */
export function extractModel(model: string): ClaudeModel {
  // Try direct lookup
  if (MODEL_MAP[model]) {
    return MODEL_MAP[model];
  }

  // Try stripping provider prefix
  const stripped = model.replace(/^(?:claude-code-cli|claude-max)\//, "");
  if (MODEL_MAP[stripped]) {
    return MODEL_MAP[stripped];
  }

  // Default to opus (Claude Max subscription)
  return "opus";
}

/**
 * Extract text from a content field that may be a string or array of content blocks.
 * OpenAI API allows content as either:
 *   - A plain string: "Hello"
 *   - An array of content blocks: [{"type": "text", "text": "Hello"}]
 */
function extractText(content: string | OpenAIContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text" || block.type === "input_text")
      .map((block) => block.text)
      .join("\n");
  }
  return String(content || "");
}

/**
 * Strip OpenClaw-specific tooling sections from system prompts.
 * These reference tools (exec, process, web_search, etc.) that don't exist
 * in the Claude Code CLI environment, causing the model to get confused.
 * We remove: ## Tooling, ## Tool Call Style, ## OpenClaw CLI Quick Reference,
 * ## OpenClaw Self-Update
 */
function stripOpenClawTooling(text: string): string {
  const sectionsToStrip = [
    "## Tooling",
    "## Tool Call Style",
    "## OpenClaw CLI Quick Reference",
    "## OpenClaw Self-Update",
  ];
  let result = text;
  for (const section of sectionsToStrip) {
    // Match from section header to the next ## header (or end of string)
    const pattern = new RegExp(
      section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "\\n[\\s\\S]*?(?=\\n## |$)",
      "g"
    );
    result = result.replace(pattern, "");
  }
  // Clean up excessive blank lines left behind
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 */
export function messagesToPrompt(
  messages: OpenAIChatRequest["messages"]
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const text = extractText(msg.content);
    switch (msg.role) {
      case "system":
        // System messages become context instructions
        // Strip OpenClaw tooling sections that conflict with Claude Code's native tools
        parts.push(`<system>\n${stripOpenClawTooling(text)}\n</system>\n`);
        break;

      case "user":
        // User messages are the main prompt
        parts.push(text);
        break;

      case "assistant":
        // Previous assistant responses for context
        parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        break;
    }
  }

  return parts.join("\n").trim();
}

/**
 * Extract the last user message from the messages array.
 * For resumed sessions, we only need the latest user message —
 * the CLI already has the full conversation history.
 */
function lastUserMessage(messages: OpenAIChatRequest["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return extractText(messages[i].content);
    }
  }
  return extractText(messages[messages.length - 1].content);
}

/**
 * Extract system prompt from messages (for new sessions only).
 */
function extractSystemPrompt(messages: OpenAIChatRequest["messages"]): string | undefined {
  const systemParts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(stripOpenClawTooling(extractText(msg.content)));
    }
  }
  return systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
}

/**
 * Detect if this is a new session or a continuation.
 * A single user message (optionally with system) = new session.
 * Multiple user/assistant turns = continuation.
 */
function detectNewSession(messages: OpenAIChatRequest["messages"]): boolean {
  const userCount = messages.filter((m) => m.role === "user").length;
  const assistantCount = messages.filter((m) => m.role === "assistant").length;
  return assistantCount === 0 && userCount <= 1;
}

/**
 * Derive a deterministic agent key from system prompt + model.
 * Same system prompt + model always produces the same key, ensuring
 * session continuity regardless of what OpenClaw sends in `user`.
 * Uses djb2 hash for fast, low-collision hashing.
 */
export function deriveAgentKey(
  messages: OpenAIChatRequest["messages"],
  model: string
): string | undefined {
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => extractText(m.content))
    .join("");

  if (!systemText) return undefined;

  // Use first 200 chars — the stable identity portion of system prompts
  const input = systemText.slice(0, 200) + "|" + model;
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return `agent-${hash.toString(16)}`;
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  const isNew = detectNewSession(request.messages);
  const model = extractModel(request.model);
  const agentKey =
    deriveAgentKey(request.messages, request.model) ||
    request.user ||
    `anon-${Date.now().toString(36)}`;

  // Always compute all prompt variants so routes.ts can pick the right one
  // when the session manager overrides the adapter's new/resume decision.
  const fullPrompt = messagesToPrompt(request.messages);
  const fullSystemPrompt = extractSystemPrompt(request.messages);
  const resumePrompt = lastUserMessage(request.messages);

  return {
    prompt: isNew ? fullPrompt : resumePrompt,
    fullPrompt,
    resumePrompt,
    systemPrompt: isNew ? fullSystemPrompt : undefined,
    fullSystemPrompt,
    model,
    agentKey,
    sessionId: request.user,
    isNewSession: isNew,
  };
}
