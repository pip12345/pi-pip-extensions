import type { ScopedSettings } from "../../pip-common/index.ts";
import { loadTinyMcpConfig } from "./config.ts";
import { readCache, updateCachedTools } from "./cache.ts";
import type { StderrMode, TimeoutSetting, ToolPrefix } from "./settings.ts";
import { TinyMcpClient } from "./mcp-client.ts";
import { isExplicitlyDisconnected, setExplicitlyDisconnected } from "./state.ts";
import type { McpToolInfo, ServerStatus, TinyMcpConfig, VisibleToolInfo } from "./types.ts";

interface ServerState {
  name: string;
  status: ServerStatus;
  client?: TinyMcpClient;
  connectPromise?: Promise<void>;
  tools: McpToolInfo[];
  lastError?: string;
  runtime?: boolean;
}

export class TinyMcpManager {
  readonly config: TinyMcpConfig & { sources: string[] };
  private states = new Map<string, ServerState>();
  private visibleTools = new Map<string, VisibleToolInfo>();

  constructor(cwd = process.cwd(), private readonly settings: ScopedSettings, options: { projectTrusted?: boolean } = {}) {
    this.config = loadTinyMcpConfig(cwd, options);
    const cache = settings.get("metadataCache", true) ? readCache() : { servers: {} };
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
      const runtime = state.runtime ? " [runtime]" : "";
      const err = state.lastError ? ` - ${state.lastError}` : "";
      lines.push(`  ${state.name}: ${state.status}, ${count} tools${runtime}${err}`);
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

  async addRuntimeServer(serverName: string, config: TinyMcpConfig["mcpServers"][string]): Promise<void> {
    const name = serverName.trim();
    if (!name) throw new Error("Runtime MCP server name is required");
    if (config.disabled) throw new Error(`Runtime MCP server cannot be disabled: ${name}`);
    const existing = this.states.get(name);
    if (existing) await this.close(name);
    this.config.mcpServers[name] = config;
    this.states.set(name, { name, status: "disconnected", tools: [], runtime: true });
    this.rebuildVisibleTools();
  }

  async connect(serverName: string, signal?: AbortSignal): Promise<void> {
    const state = this.requireState(serverName);
    if (!state.runtime) setExplicitlyDisconnected([serverName], false);
    if (state.connectPromise) return waitForConnection(state.connectPromise, signal);
    if (state.status === "connected") return;

    const config = this.config.mcpServers[serverName];
    if (!config || config.disabled) throw new Error(`Server not configured: ${serverName}`);
    state.status = "connecting";
    state.lastError = undefined;
    const client = new TinyMcpClient({ name: serverName, config, timeoutMs: config.timeoutMs ?? Number(this.settings.get<TimeoutSetting>("defaultTimeout", "120")) * 1000, stderr: this.settings.get<StderrMode>("stderr", "tail") });
    client.on("notification", (method) => {
      if (method === "notifications/tools/list_changed") void this.refreshTools(serverName).catch((error) => { state.lastError = error instanceof Error ? error.message : String(error); });
    });
    client.on("close", () => {
      if (state.client === client && state.status !== "error") state.status = "disconnected";
    });
    state.client = client;

    const connectPromise = (async () => {
      try {
        await client.connect(signal);
        if (state.client !== client) throw new Error(`MCP connection was replaced: ${serverName}`);
        await this.refreshTools(serverName, signal);
        if (state.client !== client) throw new Error(`MCP connection was replaced: ${serverName}`);
        state.status = "connected";
      } catch (error) {
        if (state.client === client) {
          state.status = "error";
          state.lastError = error instanceof Error ? error.message : String(error);
        }
        await client.close().catch(() => undefined);
        throw error;
      }
    })();
    state.connectPromise = connectPromise;
    try {
      await connectPromise;
    } finally {
      if (state.connectPromise === connectPromise) state.connectPromise = undefined;
    }
  }

  async refreshTools(serverName: string, signal?: AbortSignal): Promise<void> {
    const state = this.requireState(serverName);
    if (!state.client) return;
    state.tools = await state.client.listTools(signal);
    if (!state.runtime && this.settings.get("metadataCache", true)) updateCachedTools(serverName, state.tools);
    this.rebuildVisibleTools();
  }

  async callVisibleTool(visibleName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const tool = this.findTool(visibleName);
    if (!tool) throw new Error(`Unknown MCP tool: ${visibleName}`);
    await this.connect(tool.serverName, signal);
    const state = this.requireState(tool.serverName);
    const result = await state.client!.callTool(tool.originalName, args, signal);
    return result;
  }

  async connectEligible(signal?: AbortSignal): Promise<{ connected: string[]; failed: { server: string; error: string }[] }> {
    const connected: string[] = [];
    const failed: { server: string; error: string }[] = [];
    for (const serverName of this.serverNames()) {
      const state = this.requireState(serverName);
      if (!state.runtime && isExplicitlyDisconnected(serverName)) continue;
      try {
        await this.connect(serverName, signal);
        connected.push(serverName);
      } catch (error) {
        failed.push({ server: serverName, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { connected, failed };
  }

  async close(serverName?: string): Promise<void> {
    const targets = serverName ? [this.requireState(serverName)] : [...this.states.values()];
    await Promise.all(targets.map(async (state) => {
      const client = state.client;
      state.client = undefined;
      await client?.close().catch(() => undefined);
      await state.connectPromise?.catch(() => undefined);
      state.connectPromise = undefined;
      state.status = "disconnected";
    }));
  }

  async disconnect(serverName?: string): Promise<void> {
    const targets = serverName ? [this.requireState(serverName)] : [...this.states.values()];
    const persistentNames = targets.filter((state) => !state.runtime).map((state) => state.name);
    if (persistentNames.length) setExplicitlyDisconnected(persistentNames, true);
    await this.close(serverName);
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
    const prefix = this.settings.get<ToolPrefix>("toolPrefix", "server");
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

async function waitForConnection(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("MCP connection wait aborted");
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("MCP connection wait aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
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
