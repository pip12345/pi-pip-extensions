import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { pipPath } from "../../pip-common/index.ts";
import type { McpToolInfo } from "./types.ts";

export interface TinyMcpCache {
  servers: Record<string, { tools: McpToolInfo[]; updatedAt: number }>;
}

export const CACHE_PATH = pipPath("tiny-mcp-cache.json");

export function readCache(path = CACHE_PATH): TinyMcpCache {
  try {
    if (!existsSync(path)) return { servers: {} };
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed?.servers && typeof parsed.servers === "object" ? parsed : { servers: {} };
  } catch {
    return { servers: {} };
  }
}

export function writeCache(cache: TinyMcpCache, path = CACHE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
}

export function updateCachedTools(serverName: string, tools: McpToolInfo[], path = CACHE_PATH): void {
  const cache = readCache(path);
  cache.servers[serverName] = { tools, updatedAt: Date.now() };
  writeCache(cache, path);
}
