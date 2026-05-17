import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipPath } from "pip-common";
import type { ConfigTarget } from "./settings.ts";
import type { TinyMcpConfig, TinyMcpServerConfig } from "./types.ts";

export interface ConfigSource {
  path: string;
  kind: "global" | "pip" | "project" | "project-pip";
}

export function configPathForTarget(target: ConfigTarget, cwd = process.cwd()): string {
  if (target === "global") return join(homedir(), ".config", "mcp", "mcp.json");
  if (target === "project") return join(cwd, ".mcp.json");
  return pipPath("tiny-mcp.json");
}

export function configSources(cwd = process.cwd()): ConfigSource[] {
  return [
    { kind: "global", path: join(homedir(), ".config", "mcp", "mcp.json") },
    { kind: "pip", path: pipPath("tiny-mcp.json") },
    { kind: "project", path: join(cwd, ".mcp.json") },
    { kind: "project-pip", path: join(cwd, ".pi", "tiny-mcp.json") },
  ];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown, field: string, serverName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`Server "${serverName}" field ${field} must be a string array.`);
  return value;
}

function asEnv(value: unknown, serverName: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Server "${serverName}" field env must be an object.`);
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) out[key] = String(raw);
  return out;
}

function validateServer(name: string, raw: unknown): TinyMcpServerConfig {
  if (!isRecord(raw)) throw new Error(`Server "${name}" must be an object.`);
  if ("url" in raw) throw new Error(`Server "${name}" uses url/HTTP transport. pi-tiny-mcp only supports stdio command servers.`);
  if ("auth" in raw || "oauth" in raw || "headers" in raw) throw new Error(`Server "${name}" uses HTTP auth fields. pi-tiny-mcp only supports local stdio servers.`);
  if (raw.disabled !== undefined && typeof raw.disabled !== "boolean") throw new Error(`Server "${name}" field disabled must be boolean.`);
  if (raw.disabled === true && raw.command === undefined) return { command: "", disabled: true };
  if (typeof raw.command !== "string" || !raw.command.trim()) throw new Error(`Server "${name}" requires a non-empty command.`);
  if (raw.cwd !== undefined && typeof raw.cwd !== "string") throw new Error(`Server "${name}" field cwd must be a string.`);
  if (raw.timeoutMs !== undefined && (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0)) throw new Error(`Server "${name}" field timeoutMs must be a positive number.`);
  return {
    command: raw.command,
    args: asStringArray(raw.args, "args", name),
    cwd: raw.cwd,
    env: asEnv(raw.env, name),
    timeoutMs: raw.timeoutMs,
    disabled: raw.disabled,
  };
}

function parseConfig(path: string, raw: unknown): TinyMcpConfig {
  if (!isRecord(raw)) throw new Error(`Config ${path} must be an object.`);
  const serversRaw = raw.mcpServers;
  if (serversRaw === undefined) return { settings: isRecord(raw.settings) ? raw.settings : undefined, mcpServers: {} };
  if (!isRecord(serversRaw)) throw new Error(`Config ${path} field mcpServers must be an object.`);
  const mcpServers: Record<string, TinyMcpServerConfig> = {};
  for (const [name, serverRaw] of Object.entries(serversRaw)) mcpServers[name] = validateServer(name, serverRaw);
  return { settings: isRecord(raw.settings) ? raw.settings : undefined, mcpServers };
}

export function loadTinyMcpConfig(cwd = process.cwd()): TinyMcpConfig & { sources: string[] } {
  const merged: TinyMcpConfig & { sources: string[] } = { mcpServers: {}, settings: {}, sources: [] };
  for (const source of configSources(cwd)) {
    if (!existsSync(source.path)) continue;
    const parsed = parseConfig(source.path, readJson(source.path));
    merged.sources.push(source.path);
    merged.settings = { ...(merged.settings ?? {}), ...(parsed.settings ?? {}) };
    merged.mcpServers = { ...merged.mcpServers, ...parsed.mcpServers };
  }
  for (const [name, server] of Object.entries(merged.mcpServers)) {
    if (server.cwd) server.cwd = resolve(cwd, server.cwd.replace(/^~(?=$|\/|\\)/, homedir()));
  }
  return merged;
}

export function ensureConfigFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, '{\n  "mcpServers": {}\n}\n');
}
