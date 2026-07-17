import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pipPath } from "../../pip-common/index.ts";

export interface TinyMcpState {
  explicitlyDisconnected: string[];
}

export const STATE_PATH = pipPath("tiny-mcp-state.json");

export function readState(path = STATE_PATH): TinyMcpState {
  try {
    if (!existsSync(path)) return { explicitlyDisconnected: [] };
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const disconnected: string[] = Array.isArray(parsed?.explicitlyDisconnected) ? parsed.explicitlyDisconnected.filter((name: unknown): name is string => typeof name === "string") : [];
    return { explicitlyDisconnected: [...new Set<string>(disconnected)].sort() };
  } catch {
    return { explicitlyDisconnected: [] };
  }
}

export function writeState(state: TinyMcpState, path = STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ explicitlyDisconnected: [...new Set(state.explicitlyDisconnected)].sort() }, null, 2)}\n`);
}

export function setExplicitlyDisconnected(serverNames: string[], disconnected: boolean, path = STATE_PATH): void {
  const state = readState(path);
  const names = new Set(state.explicitlyDisconnected);
  for (const name of serverNames) {
    if (disconnected) names.add(name);
    else names.delete(name);
  }
  writeState({ explicitlyDisconnected: [...names].sort() }, path);
}

export function isExplicitlyDisconnected(serverName: string, path = STATE_PATH): boolean {
  return readState(path).explicitlyDisconnected.includes(serverName);
}
