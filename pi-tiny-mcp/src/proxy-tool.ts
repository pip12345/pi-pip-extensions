import { Type } from "typebox";
import { firstResultText, registerPipTool } from "pip-common";
import { parseTinyMcpServerConfig } from "./config.ts";
import { resultLimit } from "./settings.ts";
import { TinyMcpManager } from "./manager.ts";
import type { TinyMcpServerConfig, VisibleToolInfo } from "./types.ts";

const managers = new Map<string, TinyMcpManager>();

export interface TinyMcpExecutionOptions {
  projectTrusted?: boolean;
}

export function getManager(cwd = process.cwd(), options: TinyMcpExecutionOptions = {}): TinyMcpManager {
  const projectTrusted = options.projectTrusted !== false;
  const key = `${projectTrusted ? "trusted" : "untrusted"}\0${cwd}`;
  let manager = managers.get(key);
  if (!manager) {
    manager = new TinyMcpManager(cwd, { projectTrusted });
    managers.set(key, manager);
  }
  return manager;
}

export async function shutdownManager(): Promise<void> {
  await Promise.all([...managers.values()].map((manager) => manager.close().catch(() => undefined)));
  managers.clear();
}

export function resetManager(): void {
  managers.clear();
}

export function registerTinyMcpTool(pi: any): void {
  registerPipTool(pi, {
    tool: {
      name: "tiny-mcp",
      label: "tiny-mcp",
      description: "Tiny stdio/HTTP MCP proxy. List/search/describe/call MCP tools without OAuth or SDK bloat.",
      promptSnippet: "Use tiny-mcp to discover and call configured stdio or HTTP MCP tools on demand.",
      promptGuidelines: [
        "Use tiny-mcp({ search: \"...\" }) to find MCP tools before calling unfamiliar ones.",
        "Use tiny-mcp({ describe: \"tool_name\" }) to inspect required arguments before calling a tool.",
        "Call tools with tiny-mcp({ tool: \"tool_name\", args: \"{...}\" }); args must be a JSON string object.",
        "If no tools are cached for a server, use tiny-mcp({ connect: \"server\" }) first.",
        "For temporary memory-only testing, use tiny-mcp({ action: \"add\", server: \"name\", config: \"{...}\", connect: true }); config must be a JSON string MCP server object and is not persisted.",
        "When the user wants to configure MCP servers for this adapter, edit the PiP-owned file ~/.pi/agent/pip/tiny-mcp.json directly.",
        "Set up ~/.pi/agent/pip/tiny-mcp.json as { \"mcpServers\": { \"serverName\": { \"command\": \"cmd\", \"args\": [\"arg1\"] } } }; optional stdio fields are cwd, env, timeoutMs, and disabled.",
        "For HTTP MCP servers, configure { \"type\": \"http\", \"url\": \"https://example.com/mcp\" }; optional HTTP fields are headers, timeoutMs, and disabled.",
        "Shared MCP config files are ~/.config/mcp/mcp.json for user-global and .mcp.json for project-local. Edit shared files only when the user explicitly asks for shared/global/project MCP config.",
        "pi-tiny-mcp supports static HTTP headers but not OAuth. Do not add auth or oauth fields to tiny-mcp config.",
      ],
      parameters: Type.Object({
        server: Type.Optional(Type.String({ description: "List tools for a server" })),
        search: Type.Optional(Type.String({ description: "Search MCP tools" })),
        describe: Type.Optional(Type.String({ description: "Describe a visible MCP tool name" })),
        tool: Type.Optional(Type.String({ description: "Visible MCP tool name to call" })),
        args: Type.Optional(Type.String({ description: "JSON string arguments for tool call" })),
        connect: Type.Optional(Type.Union([Type.String(), Type.Boolean()], { description: "Connect to a server and refresh tools, or true with action:add" })),
        config: Type.Optional(Type.String({ description: "JSON string MCP server config for action:add" })),
        action: Type.Optional(Type.String({ description: "status/disconnect/add" })),
      }),
      execute: async (_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) => executeTinyMcp(params ?? {}, ctx?.cwd ?? process.cwd(), { projectTrusted: ctx?.isProjectTrusted?.() === true }),
    },
    metadata: {
      pluginId: "tiny-mcp",
      label: "MCP",
      display: {
        kind: "command",
        call: (args: any) => args?.tool ? args.tool : args?.search ? `search ${args.search}` : args?.connect ? `connect ${args.connect}` : "status",
        result: (result: any) => {
          const text = firstResultText(result).trim();
          return /^error\b/i.test(text) ? text.split("\n")[0] : undefined;
        },
        expandedResult: firstResultText,
        hideSuccessfulResult: true,
      },
    },
  });
}

export async function executeTinyMcp(input: any, cwd = process.cwd(), options: TinyMcpExecutionOptions = {}) {
  const m = getManager(cwd, options);
  try {
    if (input.action === "add") {
      const serverName = parseServerName(input.server);
      const config = parseRuntimeServerConfig(input.config, serverName, cwd);
      await m.addRuntimeServer(serverName, config);
      if (input.connect === true || input.connect === "true" || input.connect === serverName) {
        await m.connect(serverName);
        return textResult(`Added memory-only MCP server ${serverName} and connected.\n${formatTools(m.allTools().filter((tool) => tool.serverName === serverName))}`);
      }
      return textResult(`Added memory-only MCP server ${serverName}. Use tiny-mcp({ connect: "${serverName}" }) to connect.`);
    }
    if (typeof input.connect === "boolean") throw new Error("connect:true is only valid with action:add; use connect:\"server\" otherwise");
    if (input.connect) {
      await m.connect(String(input.connect));
      return textResult(`Connected ${input.connect}.\n${formatTools(m.allTools().filter((tool) => tool.serverName === input.connect))}`);
    }
    if (input.action === "disconnect") {
      await m.disconnect(typeof input.server === "string" ? input.server : undefined);
      return textResult("Disconnected MCP server(s).");
    }
    if (input.server) return textResult(formatTools(m.allTools().filter((tool) => tool.serverName === String(input.server))) || `No cached tools for ${input.server}. Try tiny-mcp({ connect: "${input.server}" }).`);
    if (input.search) return textResult(formatTools(searchTools(m.allTools(), String(input.search))) || "No matching MCP tools.");
    if (input.describe) {
      const tool = m.findTool(String(input.describe));
      if (!tool) throw new Error(`Unknown MCP tool: ${input.describe}`);
      return textResult(describeTool(tool));
    }
    if (input.tool) {
      const args = parseArgs(input.args);
      const result = await m.callVisibleTool(String(input.tool), args);
      return mcpResultToPi(result);
    }
    return textResult(m.status());
  } catch (error) {
    return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseServerName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("server is required for action:add");
  return raw.trim();
}

function parseRuntimeServerConfig(raw: unknown, serverName: string, cwd: string): TinyMcpServerConfig {
  if (raw === undefined || raw === "") throw new Error("config is required for action:add");
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("config must be a JSON object or JSON string object");
  return parseTinyMcpServerConfig(serverName, parsed, cwd);
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === "") return {};
  if (typeof raw !== "string") throw new Error("args must be a JSON string");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("args JSON must be an object");
  return parsed as Record<string, unknown>;
}

function searchTools(tools: VisibleToolInfo[], query: string): VisibleToolInfo[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tools
    .map((tool) => ({ tool, score: scoreTool(tool, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.visibleName.localeCompare(b.tool.visibleName))
    .slice(0, 25)
    .map((item) => item.tool);
}

function scoreTool(tool: VisibleToolInfo, terms: string[]): number {
  const name = tool.visibleName.toLowerCase();
  const desc = tool.description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name === term) score += 100;
    else if (name.includes(term)) score += 20;
    if (desc.includes(term)) score += 5;
    if (tool.serverName.toLowerCase().includes(term)) score += 10;
  }
  return score;
}

function formatTools(tools: VisibleToolInfo[]): string {
  return tools.map((tool) => `${tool.visibleName}\n  ${tool.description || "(no description)"}${formatSchemaSummary(tool.inputSchema)}`).join("\n");
}

function describeTool(tool: VisibleToolInfo): string {
  return `${tool.visibleName}\nServer: ${tool.serverName}\nOriginal: ${tool.originalName}\n\n${tool.description || "(no description)"}\n\nParameters:\n${JSON.stringify(tool.inputSchema ?? { type: "object", properties: {} }, null, 2)}`;
}

function formatSchemaSummary(schema: unknown): string {
  const props = (schema as any)?.properties;
  if (!props || typeof props !== "object") return "";
  const required = new Set(Array.isArray((schema as any).required) ? (schema as any).required : []);
  const names = Object.keys(props).slice(0, 8).map((name) => `${name}${required.has(name) ? "*" : ""}`);
  return names.length ? `\n  args: ${names.join(", ")}` : "";
}

function mcpResultToPi(result: any) {
  const text = blocksToText(result?.content ?? []);
  const limit = resultLimit();
  const shown = text.length > limit ? `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]` : text;
  return { content: [{ type: "text" as const, text: shown || JSON.stringify(result) }], details: result };
}

function blocksToText(blocks: any[]): string {
  return blocks.map((block) => block?.type === "text" ? String(block.text ?? "") : `[${block?.type ?? "content"}]`).join("\n");
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: { text } };
}

