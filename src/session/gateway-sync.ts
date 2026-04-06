/**
 * Gateway Sync — WebSocket connection to OpenClaw gateway
 *
 * Passive sync: listens for session state changes (reset, delete, compact)
 * from the OpenClaw gateway and invalidates local sessions accordingly.
 * Graceful degradation: proxy works normally without gateway.
 */

import fs from "fs/promises";
import path from "path";
import { sessionManager } from "./manager.js";

interface GatewayConfig {
  host: string;
  port: number;
  token?: string;
}

interface GatewayMessage {
  type: string;
  event?: string;
  sessionId?: string;
  agentKey?: string;
  action?: string;
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
      const gw = data?.gateway || data;
      if (!gw.host || !gw.port) return null;
      return { host: gw.host, port: gw.port, token: gw.token };
    } catch {
      return null;
    }
  }

  /**
   * Establish WebSocket connection to gateway
   */
  private connect(): void {
    if (this.stopped || !this.config) return;

    const url = `ws://${this.config.host}:${this.config.port}/ws/sessions`;

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log("[GatewaySync] Connected to gateway");
      this.reconnectMs = MIN_RECONNECT_MS;

      // Authenticate if token available
      if (this.config?.token) {
        this.ws?.send(JSON.stringify({ type: "auth", token: this.config.token }));
      }

      // Subscribe to session events
      this.ws?.send(JSON.stringify({ type: "subscribe", channel: "sessions" }));
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(typeof event.data === "string" ? event.data : "");
    };

    this.ws.onclose = () => {
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after this — reconnect handled there
    };
  }

  /**
   * Handle incoming gateway message
   */
  private handleMessage(raw: string): void {
    try {
      const msg: GatewayMessage = JSON.parse(raw);

      if (msg.type === "session.changed" || msg.event === "session.changed") {
        const action = msg.action || "unknown";

        if (msg.agentKey) {
          console.log(`[GatewaySync] Session ${action} for agent ${msg.agentKey}`);
          sessionManager.invalidate(msg.agentKey);
        } else if (msg.sessionId) {
          console.log(`[GatewaySync] Session ${action} for CLI session ${msg.sessionId}`);
          sessionManager.invalidateByClaudeSessionId(msg.sessionId);
        }
      }
    } catch {
      // Ignore non-JSON or unknown messages
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
   * Check if connected to gateway
   */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// Singleton
export const gatewaySync = new GatewaySync();
