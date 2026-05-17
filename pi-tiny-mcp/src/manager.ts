import { loadTinyMcpConfig } from "./config.ts";
import { readCache, updateCachedTools } from "./cache.ts";
import { defaultTimeoutMs, settingValue, type StderrMode, type ToolPrefix } from "./settings.ts";
import { TinyMcpClient } from "./mcp-client.ts";
import type { McpToolInfo, ServerStatus, TinyMcpConfig, VisibleToolInfo } from "./types.ts";

interface ServerState {
  name: string;
  status: ServerStatus;
  client?: TinyMcpClient;
  tools: McpToolInfo[];
  lastError?: string;
}

export class TinyMcpManager {
  readonly config: TinyMcpConfig & { sources: string[] };
  private states = new Map<string, ServerState>();
  private visibleTools = new Map<string, VisibleToolInfo>();

  constructor(private cwd = process.cwd()) {
    this.config = loadTinyMcpConfig(cwd);
    const cache = settingValue("metadataCache", true) ? readCache() : { servers: {} };
    for (const [name, server] of Object.entries(this.config.mcpServers)) {
      if (server.disabled) continue;
      this.states.set(name, { name, status: "disconnected", tools: cache.servers[name]?.tools ?? [] });
    }
    this.rebuildVisibleTools();
  }

  serverNames(): string[] {
    return [...this.states.keys()].sort();
  }

  status(): string {
    const lines = ["Tiny MCP servers:"];
    if (!this.states.size) lines.push("  none configured");
    for (const state of [...this.states.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const count = state.tools.length;
      const err = state.lastError ? ` - ${state.lastError}` : "";
      lines.push(`  ${state.name}: ${state.status}, ${count} tools${err}`);
    }
    if (this.config.sources.length) lines.push(`\nConfig: ${this.config.sources.join(", ")}`);
    return lines.join("\n");
  }

  allTools(): VisibleToolInfo[] {
    return [...this.visibleTools.values()].sort((a, b) => a.visibleName.localeCompare(b.visibleName));
  }

  findTool(name: string): VisibleToolInfo | undefined {
    return this.visibleTools.get(name) ?? this.allTools().find((tool) => tool.visibleName.replace(/[-_]/g, "") === name.replace(/[-_]/g, ""));
  }

  async connect(serverName: string): Promise<void> {
    const state = this.requireState(serverName);
    if (state.status === "connected") return;
    const config = this.config.mcpServers[serverName];
    if (!config || config.disabled) throw new Error(`Server not configured: ${serverName}`);
    state.status = "connecting";
    state.lastError = undefined;
    const client = new TinyMcpClient({ name: serverName, config, timeoutMs: config.timeoutMs ?? defaultTimeoutMs(), stderr: settingValue<StderrMode>("stderr", "tail") });
    client.on("notification", (method) => {
      if (method === "notifications/tools/list_changed") void this.refreshTools(serverName).catch((error) => { state.lastError = error instanceof Error ? error.message : String(error); });
    });
    client.on("close", () => {
      if (state.status !== "error") state.status = "disconnected";
    });
    try {
      state.client = client;
      await client.connect();
      state.status = "connected";
      await this.refreshTools(serverName);
    } catch (error) {
      state.status = "error";
      state.lastError = error instanceof Error ? error.message : String(error);
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async refreshTools(serverName: string): Promise<void> {
    const state = this.requireState(serverName);
    if (!state.client) return;
    state.tools = await state.client.listTools();
    if (settingValue("metadataCache", true)) updateCachedTools(serverName, state.tools);
    this.rebuildVisibleTools();
  }

  async callVisibleTool(visibleName: string, args: Record<string, unknown>): Promise<any> {
    const tool = this.findTool(visibleName);
    if (!tool) throw new Error(`Unknown MCP tool: ${visibleName}`);
    await this.connect(tool.serverName);
    const state = this.requireState(tool.serverName);
    const result = await state.client!.callTool(tool.originalName, args);
    return result;
  }

  async disconnect(serverName?: string): Promise<void> {
    const targets = serverName ? [this.requireState(serverName)] : [...this.states.values()];
    await Promise.all(targets.map(async (state) => {
      await state.client?.close().catch(() => undefined);
      state.client = undefined;
      state.status = "disconnected";
    }));
  }

  stderrTail(serverName: string): string[] {
    return this.requireState(serverName).client?.stderrTail() ?? [];
  }

  private requireState(serverName: string): ServerState {
    const state = this.states.get(serverName);
    if (!state) throw new Error(`Unknown MCP server: ${serverName}`);
    return state;
  }

  private rebuildVisibleTools(): void {
    const next = new Map<string, VisibleToolInfo>();
    const used = new Set<string>();
    const prefix = settingValue<ToolPrefix>("toolPrefix", "server");
    for (const state of this.states.values()) {
      for (const tool of state.tools) {
        const base = normalizeName(prefix === "server" ? `${state.name}_${tool.name}` : tool.name);
        const visibleName = allocateName(base, used);
        next.set(visibleName, { visibleName, serverName: state.name, originalName: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema });
      }
    }
    this.visibleTools = next;
  }
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "tool";
}

function allocateName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}_${i}`)) i++;
  const name = `${base}_${i}`;
  used.add(name);
  return name;
}
