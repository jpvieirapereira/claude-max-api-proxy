/**
 * Gateway Sync — WebSocket connection to OpenClaw gateway
 *
 * Passive sync: listens for session state changes (reset, delete, compact)
 * from the OpenClaw gateway and invalidates local sessions accordingly.
 * Graceful degradation: proxy works normally without gateway.
 *
 * OpenClaw gateway protocol:
 *   1. Connect to ws://{host}:{port}/
 *   2. Server sends connect.challenge with nonce
 *   3. Client responds with connect.respond containing token + nonce
 *   4. Server sends connect.ack on success
 *   5. Client subscribes to channels
 *   6. Server pushes events
 */

import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { sessionManager } from "./manager.js";

interface GatewayConfig {
  host: string;
  port: number;
  token?: string;
}

const OPENCLAW_CONFIG_PATH = path.join(
  process.env.HOME || "/tmp",
  ".openclaw",
  "openclaw.json"
);

const MIN_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;

export class GatewaySync {
  private ws: WebSocket | null = null;
  private reconnectMs = MIN_RECONNECT_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private config: GatewayConfig | null = null;
  private authenticated = false;

  /**
   * Initialize: read config and connect if available.
   * Non-blocking — errors are logged, not thrown.
   */
  async init(): Promise<void> {
    try {
      this.config = await this.readConfig();
      if (!this.config) {
        console.log("[GatewaySync] No OpenClaw gateway config found — running standalone");
        return;
      }
      console.log(`[GatewaySync] Connecting to gateway at ${this.config.host}:${this.config.port}`);
      this.connect();
    } catch (err) {
      console.warn("[GatewaySync] Init failed:", err instanceof Error ? err.message : err);
    }
  }

  /**
   * Read OpenClaw gateway config from ~/.openclaw/openclaw.json
   */
  private async readConfig(): Promise<GatewayConfig | null> {
    try {
      const raw = await fs.readFile(OPENCLAW_CONFIG_PATH, "utf-8");
      const data = JSON.parse(raw);
      const gw = data?.gateway;
      if (!gw || !gw.port) return null;

      let host = gw.host;
      if (!host) {
        host = gw.bind === "loopback" || gw.bind === "localhost" || !gw.bind
          ? "127.0.0.1"
          : gw.bind;
      }

      const token = gw.token || gw.auth?.token;
      return { host, port: gw.port, token };
    } catch {
      return null;
    }
  }

  /**
   * Establish WebSocket connection to gateway (root path /)
   */
  private connect(): void {
    if (this.stopped || !this.config) return;

    this.authenticated = false;
    const url = `ws://${this.config.host}:${this.config.port}/`;

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log("[GatewaySync] WebSocket connected, waiting for challenge...");
      this.reconnectMs = MIN_RECONNECT_MS;
    };

    this.ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      this.handleMessage(raw);
    };

    this.ws.onclose = () => {
      this.authenticated = false;
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  /**
   * Send a request frame to the gateway (OpenClaw protocol v3)
   */
  private sendRequest(method: string, params: Record<string, unknown> = {}): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "req",
        id: randomUUID(),
        method,
        params,
      }));
    }
  }

  /**
   * Handle incoming gateway message
   *
   * OpenClaw protocol v3:
   *   Event frames:  { type: "event", event: "...", payload: {...}, seq?: N }
   *   Response frames: { type: "res", id: "...", ok: bool, payload?: {...}, error?: {...} }
   */
  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const type = msg.type as string;

    // Response to our connect request
    if (type === "res") {
      const ok = msg.ok as boolean;
      if (ok && !this.authenticated) {
        this.authenticated = true;
        console.log("[GatewaySync] Authenticated with gateway");
      } else if (!ok && !this.authenticated) {
        const error = msg.error as { message?: string } | undefined;
        console.warn("[GatewaySync] Gateway rejected:", error?.message || "unknown");
        this.stopped = true;
        this.ws?.close();
      }
      return;
    }

    // Event frames
    if (type !== "event") return;
    const event = msg.event as string;

    // Step 1: connect.challenge — send connect request with auth
    if (event === "connect.challenge") {
      const payload = msg.payload as { nonce?: string } | undefined;
      const nonce = payload?.nonce;
      if (!nonce) return;

      this.sendRequest("connect", {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "gateway-client",
          version: "1.0.0",
          platform: process.platform,
          mode: "backend",
        },
        caps: [],
        auth: this.config?.token ? { token: this.config.token } : undefined,
        role: "operator",
        scopes: ["operator.read"],
      });
      console.log("[GatewaySync] Responded to challenge");
      return;
    }

    // Ignore events until authenticated
    if (!this.authenticated) return;

    // Step 2: Handle session events
    if (
      event === "sessions.changed" ||
      event === "sessions.reset" ||
      event === "sessions.delete" ||
      event === "sessions.compact" ||
      event === "session.changed" ||
      event === "session.reset" ||
      event === "session.deleted" ||
      event === "session.compact"
    ) {
      const data = (msg.payload || msg) as Record<string, unknown>;
      const agentKey = data.agentKey as string | undefined;
      const sessionId = (data.sessionId || data.key) as string | undefined;
      const action = event.replace(/^sessions?\./, "");

      if (agentKey) {
        console.log(`[GatewaySync] Session ${action} for agent ${agentKey}`);
        sessionManager.invalidate(agentKey);
      } else if (sessionId) {
        console.log(`[GatewaySync] Session ${action} for session ${sessionId}`);
        sessionManager.invalidateByClaudeSessionId(sessionId);
      }
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.stopped) return;
    console.log(`[GatewaySync] Reconnecting in ${this.reconnectMs}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS);
      this.connect();
    }, this.reconnectMs);
  }

  /**
   * Stop the gateway sync (for graceful shutdown)
   */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    console.log("[GatewaySync] Stopped");
  }

  /**
   * Check if connected and authenticated
   */
  get connected(): boolean {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN;
  }
}

// Singleton
export const gatewaySync = new GatewaySync();
