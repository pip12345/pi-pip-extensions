import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { QuotaCredentials } from "./types.ts";

export function loadPiAuthJson(authPath = join(homedir(), ".pi", "agent", "auth.json")): Record<string, any> {
  try {
    if (existsSync(authPath)) return JSON.parse(readFileSync(authPath, "utf8"));
  } catch {}
  return {};
}

export function resolveAuthValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("!")) {
    try {
      return execSync(trimmed.slice(1), { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 2000 }).trim() || undefined;
    } catch {
      return undefined;
    }
  }
  if (/^[A-Z][A-Z0-9_]*$/.test(trimmed) && process.env[trimmed]) return process.env[trimmed];
  return trimmed;
}

export function getClaudeToken(auth: Record<string, any> = loadPiAuthJson()): string | undefined {
  const credential = auth.anthropic;
  return credential?.type === "oauth" && typeof credential.access === "string" ? credential.access : undefined;
}

export function getCopilotToken(auth: Record<string, any> = loadPiAuthJson(), env: NodeJS.ProcessEnv = process.env): string | undefined {
  const credential = auth["github-copilot"];
  if (credential?.type === "oauth") return credential.access ?? credential.refresh;
  return env.GITHUB_COPILOT_TOKEN;
}

export function getCodexCredentials(options: { auth?: Record<string, any>; env?: NodeJS.ProcessEnv; codexAuthPath?: string } = {}): QuotaCredentials | undefined {
  const auth = options.auth ?? loadPiAuthJson();
  const env = options.env ?? process.env;
  const credential = auth["openai-codex"];
  if (credential?.type === "oauth" && typeof credential.access === "string") {
    return { token: credential.access, accountId: credential.accountId ?? credential.account_id };
  }

  const codexPath = options.codexAuthPath ?? join(env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
  try {
    if (existsSync(codexPath)) {
      const data = JSON.parse(readFileSync(codexPath, "utf8"));
      if (data.tokens?.access_token) return { token: data.tokens.access_token, accountId: data.tokens.account_id };
    }
  } catch {}
  return undefined;
}
