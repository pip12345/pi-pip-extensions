import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettingsSection, setting, settingsFor } from "../pip-common/index.ts";

const execFileAsync = promisify(execFile);

export const SETTINGS_ID = "gitignore-guard";

type BashGuard = "off" | "best-effort" | "block";

registerSettingsSection({
  id: SETTINGS_ID,
  title: "Gitignore Guard",
  description: "Block Pi from reading or editing paths matched by the current repository's .gitignore rules.",
  order: 55,
  settings: {
    enabled: setting.boolean({ label: "Enabled", default: true, order: 1, description: "Enable .gitignore-based tool blocking." }),
    protectReads: setting.boolean({ label: "Protect reads", default: true, order: 2, description: "Block read tool calls for ignored paths." }),
    protectWrites: setting.boolean({ label: "Protect writes", default: true, order: 3, description: "Block write and edit tool calls for ignored paths." }),
    protectSearchTargets: setting.boolean({ label: "Protect search/list", default: true, order: 4, description: "Block ls, grep, and find when their explicit target path is ignored." }),
    bashGuard: setting.enum({
      label: "Bash guard",
      default: "best-effort",
      choices: [
        { value: "off", label: "off" },
        { value: "best-effort", label: "best-effort" },
        { value: "block", label: "block" },
      ] as const,
      order: 5,
      description: "Best-effort scans shell tokens for ignored paths, or block bash entirely.",
    }),
    promptReminder: setting.boolean({ label: "Prompt reminder", default: true, order: 6, description: "Tell the model not to access .gitignore paths or bypass this guard with bash." }),
  },
});

const scopedSettings = settingsFor(SETTINGS_ID);
const settingValue = scopedSettings.get;
const repoRootCache = new Map<string, string | null>();

function stripAtPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

export function resolveToolPath(cwd: string, inputPath: unknown): string | undefined {
  if (typeof inputPath !== "string" || !inputPath.trim()) return undefined;
  const cleaned = expandHome(stripAtPrefix(inputPath.trim()));
  return isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned);
}

async function repoRootFor(cwd: string): Promise<string | null> {
  const key = resolve(cwd);
  if (repoRootCache.has(key)) return repoRootCache.get(key)!;
  try {
    const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: key });
    const root = result.stdout.trim() || null;
    repoRootCache.set(key, root);
    return root;
  } catch {
    repoRootCache.set(key, null);
    return null;
  }
}

function pathForGit(repoRoot: string, absolutePath: string): string | undefined {
  const rel = relative(repoRoot, absolutePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split("\\").join("/");
}

export async function isGitIgnored(cwd: string, absolutePath: string): Promise<boolean> {
  const repoRoot = await repoRootFor(cwd);
  if (!repoRoot) return false;
  const rel = pathForGit(repoRoot, absolutePath);
  if (!rel) return false;
  try {
    await execFileAsync("git", ["check-ignore", "--quiet", "--no-index", "--", rel], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

function reminder(systemPrompt: string): string {
  return `${systemPrompt}\n\nGitignore guard is active. Treat paths matched by .gitignore as inaccessible: do not read, list, search, write, edit, summarize, reveal, or infer their contents. Do not use bash or another tool to bypass this guard. If the user asks for ignored content, explain that .gitignore-guard blocks access.`;
}

function explicitPathInput(event: any): unknown {
  if (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit") return event.input?.path;
  if (event.toolName === "ls" || event.toolName === "grep" || event.toolName === "find") return event.input?.path;
  return undefined;
}

function protectionEnabled(toolName: string): boolean {
  if (toolName === "read") return settingValue("protectReads", true);
  if (toolName === "write" || toolName === "edit") return settingValue("protectWrites", true);
  if (toolName === "ls" || toolName === "grep" || toolName === "find") return settingValue("protectSearchTargets", true);
  return false;
}

function unquoteToken(token: string): string {
  return token
    .replace(/^['"]|['"]$/g, "")
    .replace(/^[([<{]+/, "")
    .replace(/[),;:>\]}]+$/, "");
}

function shellWords(segment: string): string[] {
  const words: string[] = [];
  const re = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s"'`$&|<>]+)/g;
  for (const match of segment.matchAll(re)) {
    const token = unquoteToken(match[1] ?? match[2] ?? match[3] ?? "");
    if (token) words.push(token);
  }
  return words;
}

export function bashPathTokens(command: string): string[] {
  const tokens: string[] = [];
  for (const segment of command.split(/(?:&&|\|\||[;|\n])/)) {
    const words = shellWords(segment);
    let commandSeen = false;
    for (const word of words) {
      if (!commandSeen && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word)) continue;
      if (!commandSeen) {
        commandSeen = true;
        continue;
      }
      if (!word.startsWith("-")) tokens.push(word);
    }
  }
  return tokens;
}

async function blockedIgnoredPath(ctx: any, rawPath: unknown): Promise<string | undefined> {
  const absolutePath = resolveToolPath(ctx.cwd, rawPath);
  if (!absolutePath) return undefined;
  return (await isGitIgnored(ctx.cwd, absolutePath)) ? absolutePath : undefined;
}

export function shouldInjectReminder(): boolean {
  return settingValue("enabled", true) && settingValue("promptReminder", true);
}

export default function gitignoreGuard(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event: any) => {
    if (!shouldInjectReminder()) return;
    return { systemPrompt: reminder(event.systemPrompt ?? "") };
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!settingValue("enabled", true)) return;

    if (event.toolName === "bash") {
      const mode = settingValue<BashGuard>("bashGuard", "best-effort");
      if (mode === "off") return;
      if (mode === "block") return { block: true, reason: "Gitignore guard: bash is blocked by /pip-settings." };
      const command = String(event.input?.command ?? "");
      for (const token of bashPathTokens(command)) {
        const blocked = await blockedIgnoredPath(ctx, token);
        if (blocked) return { block: true, reason: `Gitignore guard blocked bash access to ignored path: ${blocked}` };
      }
      return;
    }

    if (!protectionEnabled(event.toolName)) return;
    const rawPath = explicitPathInput(event);
    const blocked = await blockedIgnoredPath(ctx, rawPath);
    if (!blocked) return;
    ctx.ui?.notify?.(`Gitignore guard blocked ${event.toolName}: ${blocked}`, "warning");
    return { block: true, reason: `Gitignore guard blocked ignored path: ${blocked}` };
  });
}

export const __test = { bashPathTokens, reminder, resolveToolPath, pathForGit };
