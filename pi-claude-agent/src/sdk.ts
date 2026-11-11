import type { AccountInfo, Options, Query, ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AgentSDK = Pick<typeof import("@anthropic-ai/claude-agent-sdk/core"), "query">;
export const loadSDK = (): Promise<AgentSDK> => import("@anthropic-ai/claude-agent-sdk/core");
export const MINIMUM_VERSION = "2.1.248";
export const IDLE_MS = 5 * 60_000;

export function executable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const usable = (path: string) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch { return false; }
  };
  if (env.PI_CLAUDE_PATH) {
    const path = resolve(env.PI_CLAUDE_PATH);
    return usable(path) ? path : undefined;
  }
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of process.platform === "win32" ? ["claude.exe", "claude"] : ["claude"]) {
      const path = join(directory, name);
      if (usable(path)) return isAbsolute(path) ? path : resolve(path);
    }
  }
  return undefined;
}

export function requireExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const path = executable(env);
  if (!path) throw new Error("Claude Code is not installed. Install it on this machine, or set PI_CLAUDE_PATH to its executable, then run `claude auth login`.");
  return path;
}

// Cached model metadata does not prove that the external CLI is still authenticated.
// Ask the CLI only when Pi resolves provider auth, never on a polling timer, and discard
// its account-status output rather than reading or retaining any credential files.
export async function authenticated(path: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  try {
    await execFileAsync(path, ["--setting-sources", "", "auth", "status"], {
      cwd, env: baseOptions(path, cwd, env).env, signal, timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
    return true;
  } catch (error) {
    signal.throwIfAborted();
    const code = (error as { code?: string | number }).code;
    if (code === 1 || code === "ENOENT") return false;
    throw new Error("Could not check Claude Code authentication. Run `claude auth status` on this machine.");
  }
}

export function atLeast(version: string, minimum: string): boolean {
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) return false;
  const parts = version.split(/[-+]/)[0]!.split(".").map(Number);
  const required = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== required[i]) return parts[i]! > required[i]!;
  }
  return true;
}

export function verifyVersion(version: string | undefined): void {
  if (!version || !atLeast(version, MINIMUM_VERSION)) {
    throw new Error(`Claude Code ${version ?? "(unknown version)"} is unsupported. Version ${MINIMUM_VERSION} or later is required. Run \`claude update\`.`);
  }
}

export function loggedIn(account: AccountInfo): boolean {
  return (account.tokenSource !== "none" && (!!account.tokenSource || !!account.subscriptionType || !!account.email))
    || !!account.apiKeySource || (!!account.apiProvider && account.apiProvider !== "firstParty");
}

// Pi owns project resources, tool authorization, compaction, and subagents. Loading the CLI's
// equivalents would give Claude capabilities and instructions that Pi cannot inspect or enforce.
export function baseOptions(path: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Options {
  return {
    pathToClaudeCodeExecutable: path,
    cwd,
    env: {
      ...env,
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      DISABLE_AUTO_COMPACT: "1",
      CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
      MAX_MCP_OUTPUT_TOKENS: "200000",
      CLAUDE_CODE_SIMPLE: undefined,
      CLAUDE_CODE_EFFORT_LEVEL: undefined,
      MCP_TOOL_TIMEOUT: undefined,
    },
    settingSources: [],
    settings: { disableAllHooks: true },
    strictMcpConfig: true,
    skills: [],
    tools: [],
    allowedTools: ["mcp__pi__*"],
    permissionMode: "dontAsk",
    verbatimPrompts: true,
    includePartialMessages: true,
    persistSession: false,
    thinking: { type: "adaptive", display: "summarized" },
  };
}

export async function bounded<T>(work: Promise<T>, signal?: AbortSignal, ms = 30_000): Promise<T> {
  if (signal?.aborted) { void work.catch(() => {}); signal.throwIfAborted(); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude Code did not respond within the control-request deadline.")), ms);
        cancel = () => reject(signal?.reason ?? new Error("Aborted"));
        signal?.addEventListener("abort", cancel, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) signal?.removeEventListener("abort", cancel);
  }
}

export interface DiscoveredModel extends ModelInfo {
  contextWindow?: number;
  // Reported by current Claude Code initialization responses before the SDK's ModelInfo declaration includes it.
  supportsThinkingOff?: boolean;
}
export interface Probe { account: AccountInfo; models: DiscoveredModel[]; version: string; }

export async function probe(sdk: AgentSDK, options: Options, signal?: AbortSignal): Promise<Probe> {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  async function* input(): AsyncGenerator<never> { await done; }
  const query: Query = sdk.query({ prompt: input(), options });
  // Drain diagnostic events without retaining provider payloads. No prompt is sent, so discovery uses no model tokens.
  const pump = (async () => { for await (const _ of query) { /* initialization uses control messages */ } })();
  pump.catch(() => {});
  try {
    const init = await bounded(query.initializationResult(), signal);
    verifyVersion(init.claude_code_version);
    if (!loggedIn(init.account)) throw new Error("Claude Code is not logged in. Run `claude auth login` on this machine.");
    const models: DiscoveredModel[] = init.models.filter((model) => model.value !== "default").map((model) => ({ ...model }));
    if (atLeast(init.claude_code_version!, "2.1.257")) {
      for (const model of models) {
        await bounded(query.setModel(model.value), signal);
        const usage = await bounded(query.getContextUsage({ detail: "summary" }), signal);
        if (Number.isSafeInteger(usage.rawMaxTokens) && usage.rawMaxTokens > 0) model.contextWindow = usage.rawMaxTokens;
      }
    }
    return { account: init.account, models, version: init.claude_code_version! };
  } finally {
    finish();
    query.close();
    await bounded(pump, undefined, 5_000).catch(() => {});
  }
}
