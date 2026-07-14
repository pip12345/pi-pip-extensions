import { EventEmitter } from "node:events";
import { HttpTransport } from "./http.ts";
import { JsonRpcPeer } from "./jsonrpc.ts";
import type { StderrMode } from "./settings.ts";
import { StdioTransport } from "./stdio.ts";
import type { McpTransport } from "./transport.ts";
import type { McpCallResult, McpToolInfo, TinyMcpServerConfig } from "./types.ts";

export interface McpClientOptions {
  name: string;
  config: TinyMcpServerConfig;
  timeoutMs: number;
  stderr: StderrMode;
}

export class TinyMcpClient extends EventEmitter {
  private transport: McpTransport;
  private peer: JsonRpcPeer;
  private initialized = false;
  protocolVersion = "2025-06-18";
  capabilities: Record<string, unknown> = {};

  constructor(private options: McpClientOptions) {
    super();
    this.transport = options.config.url ? new HttpTransport({ config: options.config }) : new StdioTransport({ ...options.config, command: options.config.command ?? "", stderr: options.stderr });
    this.peer = new JsonRpcPeer((message, signal) => this.transport.send(message, signal));
    this.transport.on("message", (message) => {
      try {
        this.peer.handle(message);
      } catch (error) {
        this.peer.close(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.transport.on("error", (error) => {
      this.peer.close(error instanceof Error ? error : new Error(String(error)));
    });
    this.transport.on("close", (info) => {
      this.peer.close(new Error(`MCP server exited: ${info.signal ?? info.code}`));
      this.initialized = false;
      this.emit("close", info);
    });
    this.peer.on("notification", (method, params) => this.emit("notification", method, params));
    this.peer.onRequest("ping", () => ({}));
    this.peer.onRequest("roots/list", () => ({ roots: [] }));
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    await this.transport.start();
    const result = await this.peer.request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "pi-tiny-mcp", version: "0.1.0" },
    }, Math.min(this.options.timeoutMs, 30000), signal);
    const version = result?.protocolVersion;
    if (typeof version === "string") this.protocolVersion = version;
    this.transport.setProtocolVersion?.(this.protocolVersion);
    this.capabilities = result?.capabilities && typeof result.capabilities === "object" ? result.capabilities : {};
    this.peer.notify("notifications/initialized");
    this.initialized = true;
  }

  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    await this.connect(signal);
    const result = await this.peer.request("tools/list", {}, this.options.timeoutMs, signal);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    await this.connect(signal);
    return await this.peer.request("tools/call", { name, arguments: args }, this.options.config.timeoutMs ?? this.options.timeoutMs, signal);
  }

  async ping(signal?: AbortSignal): Promise<void> {
    await this.connect(signal);
    await this.peer.request("ping", {}, Math.min(this.options.timeoutMs, 10000), signal);
  }

  stderrTail(): string[] {
    return this.transport.tail?.() ?? [];
  }

  async close(): Promise<void> {
    this.peer.close();
    await this.transport.close();
    this.initialized = false;
  }
}
