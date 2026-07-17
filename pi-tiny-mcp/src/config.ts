import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipPath } from "../../pip-common/index.ts";
import type { ConfigTarget } from "./settings.ts";
import type { TinyMcpConfig, TinyMcpServerConfig, TinyMcpTransportType } from "./types.ts";

export interface ConfigSource {
  path: string;
  kind: "global" | "pip" | "project" | "project-pip";
}

export function configPathForTarget(target: ConfigTarget, cwd = process.cwd()): string {
  if (target === "global") return join(homedir(), ".config", "mcp", "mcp.json");
  if (target === "project") return join(cwd, ".mcp.json");
  return pipPath("tiny-mcp.json");
}

export interface ConfigSourceOptions {
  projectTrusted?: boolean;
}

export function configSources(cwd = process.cwd(), options: ConfigSourceOptions = {}): ConfigSource[] {
  const sources: ConfigSource[] = [
    { kind: "global", path: join(homedir(), ".config", "mcp", "mcp.json") },
    { kind: "pip", path: pipPath("tiny-mcp.json") },
  ];
  if (options.projectTrusted !== false) {
    sources.push(
      { kind: "project", path: join(cwd, ".mcp.json") },
      { kind: "project-pip", path: join(cwd, ".pi", "tiny-mcp.json") },
    );
  }
  return sources;
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

function asHeaders(value: unknown, serverName: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Server "${serverName}" field headers must be an object.`);
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) out[key] = String(raw);
  return out;
}

function asTransportType(value: unknown, serverName: string): TinyMcpTransportType | undefined {
  if (value === undefined) return undefined;
  if (value !== "stdio" && value !== "http" && value !== "streamable-http" && value !== "sse") {
    throw new Error(`Server "${serverName}" field type must be one of: stdio, http, streamable-http, sse.`);
  }
  return value;
}

function validateServer(name: string, raw: unknown): TinyMcpServerConfig {
  if (!isRecord(raw)) throw new Error(`Server "${name}" must be an object.`);
  if ("auth" in raw || "oauth" in raw) throw new Error(`Server "${name}" uses auth/oauth fields. pi-tiny-mcp supports static HTTP headers only, not OAuth.`);
  if (raw.disabled !== undefined && typeof raw.disabled !== "boolean") throw new Error(`Server "${name}" field disabled must be boolean.`);
  if (raw.timeoutMs !== undefined && (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0)) throw new Error(`Server "${name}" field timeoutMs must be a positive number.`);

  const type = asTransportType(raw.type, name);
  const hasCommand = raw.command !== undefined;
  const hasUrl = raw.url !== undefined;
  if (hasCommand && hasUrl) throw new Error(`Server "${name}" must configure either command or url, not both.`);
  if (raw.disabled === true && !hasCommand && !hasUrl) return { type, disabled: true };

  if (hasUrl) {
    if (type === "stdio") throw new Error(`Server "${name}" has type stdio but configures url.`);
    if (typeof raw.url !== "string" || !raw.url.trim()) throw new Error(`Server "${name}" requires a non-empty url.`);
    return {
      type: type ?? "http",
      url: raw.url.trim(),
      headers: asHeaders(raw.headers, name),
      timeoutMs: raw.timeoutMs,
      disabled: raw.disabled,
    };
  }

  if (type === "http" || type === "streamable-http" || type === "sse") throw new Error(`Server "${name}" has type ${type} but configures no url.`);
  if (typeof raw.command !== "string" || !raw.command.trim()) throw new Error(`Server "${name}" requires a non-empty command or url.`);
  if (raw.cwd !== undefined && typeof raw.cwd !== "string") throw new Error(`Server "${name}" field cwd must be a string.`);
  return {
    type: type ?? "stdio",
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
  if (serversRaw === undefined) return { mcpServers: {} };
  if (!isRecord(serversRaw)) throw new Error(`Config ${path} field mcpServers must be an object.`);
  const mcpServers: Record<string, TinyMcpServerConfig> = {};
  for (const [name, serverRaw] of Object.entries(serversRaw)) mcpServers[name] = validateServer(name, serverRaw);
  return { mcpServers };
}

function expandEnvString(value: string, field: string, serverName: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_match, name: string, _fallbackPart: string | undefined, fallback: string | undefined) => {
    const env = process.env[name];
    if (env !== undefined) return env;
    if (fallback !== undefined) return fallback;
    throw new Error(`Server "${serverName}" field ${field} references unset environment variable ${name}.`);
  });
}

function normalizeLoadedServer(name: string, server: TinyMcpServerConfig, cwd: string): void {
  if (server.cwd) server.cwd = resolve(cwd, server.cwd.replace(/^~(?=$|\/|\\)/, homedir()));
  if (server.url) {
    server.url = expandEnvString(server.url, "url", name);
    let parsed: URL;
    try {
      parsed = new URL(server.url);
    } catch {
      throw new Error(`Server "${name}" url must be a valid http or https URL.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Server "${name}" url must use http or https.`);
  }
  if (server.headers) {
    for (const [key, value] of Object.entries(server.headers)) server.headers[key] = expandEnvString(value, `headers.${key}`, name);
  }
}

export function parseTinyMcpServerConfig(name: string, raw: unknown, cwd = process.cwd()): TinyMcpServerConfig {
  const server = validateServer(name, raw);
  normalizeLoadedServer(name, server, cwd);
  return server;
}

export function loadTinyMcpConfig(cwd = process.cwd(), options: ConfigSourceOptions = {}): TinyMcpConfig & { sources: string[] } {
  const merged: TinyMcpConfig & { sources: string[] } = { mcpServers: {}, sources: [] };
  for (const source of configSources(cwd, options)) {
    if (!existsSync(source.path)) continue;
    const parsed = parseConfig(source.path, readJson(source.path));
    merged.sources.push(source.path);
    merged.mcpServers = { ...merged.mcpServers, ...parsed.mcpServers };
  }
  for (const [name, server] of Object.entries(merged.mcpServers)) normalizeLoadedServer(name, server, cwd);
  return merged;
}

export function ensureConfigFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, '{\n  "mcpServers": {}\n}\n');
}
