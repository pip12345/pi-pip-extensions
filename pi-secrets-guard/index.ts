import { execFile } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettingsSection, setting, settingsFor, type ScopedSettings } from "../pip-common/index.ts";

const execFileAsync = promisify(execFile);

// Keep the persisted settings key for compatibility with existing /pip-settings files.
export const SETTINGS_ID = "gitignore-guard";
export const SECRETIGNORE_FILE = ".secretignore";

type BashGuard = "off" | "best-effort" | "block";
type GuardSource = "common-secrets" | ".secretignore" | ".gitignore";

export interface IgnoreRule {
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
}

export interface GuardMatch {
  absolutePath: string;
  source: GuardSource;
  pattern?: string;
}

const COMMON_SECRET_PATTERNS = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "!.env.defaults",
  "!.env.dist",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "**/.ssh/",
  "**/.aws/credentials",
  "**/.gnupg/",
  "secrets.*",
  "credentials.*",
] as const;

const COMMON_SECRET_RULES = rulesFromPatterns(COMMON_SECRET_PATTERNS);

const SECRETS_SETTINGS_SECTION = {
  id: SETTINGS_ID,
  title: "Secrets Guard",
  description: "Block Pi from reading or editing common secrets and paths listed in project .secretignore files.",
  order: 55,
  settings: {
    enabled: setting.boolean({ label: "Enabled", default: true, order: 1, description: "Enable secrets/path tool blocking." }),
    protectCommonSecrets: setting.boolean({
      label: "Common secrets",
      default: true,
      order: 2,
      description: "Block built-in secret patterns such as .env, private keys, credentials, and auth config files.",
    }),
    protectSecretignore: setting.boolean({
      label: ".secretignore",
      default: true,
      order: 3,
      description: "Block paths matched by a project .secretignore file using gitignore-style patterns.",
    }),
    protectGitignore: setting.boolean({
      label: "Legacy .gitignore",
      default: false,
      order: 4,
      description: "Also block paths matched by .gitignore. Off by default because .gitignore often contains caches and build output.",
    }),
    bashGuard: setting.enum({
      label: "Bash guard",
      default: "best-effort",
      choices: [
        { value: "off", label: "off" },
        { value: "best-effort", label: "best-effort" },
        { value: "block", label: "block" },
      ] as const,
      order: 5,
      description: "Best-effort scans shell tokens for guarded paths, or block bash entirely.",
    }),
  },
};

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

async function projectRootFor(cwd: string): Promise<string> {
  return (await repoRootFor(cwd)) ?? resolve(cwd);
}

function normalizePath(path: string): string {
  return path.split("\\").join("/");
}

function stripLeadingSlash(path: string): string {
  return path.replace(/^\/+/, "");
}

function pathForRoot(root: string, absolutePath: string): string | undefined {
  const rel = relative(root, absolutePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return normalizePath(rel);
}

function pathForGit(repoRoot: string, absolutePath: string): string | undefined {
  return pathForRoot(repoRoot, absolutePath);
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

function unescapePattern(line: string): string {
  return line.replace(/\\#/g, "#").replace(/\\!/g, "!");
}

export function parseIgnoreRules(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1).trim();
    }

    line = unescapePattern(line);
    if (!line) continue;
    rules.push({ pattern: line, negated, directoryOnly: line.endsWith("/") });
  }
  return rules;
}

function rulesFromPatterns(patterns: readonly string[]): IgnoreRule[] {
  return patterns.map((rawPattern) => {
    const negated = rawPattern.startsWith("!");
    const pattern = negated ? rawPattern.slice(1) : rawPattern;
    return { pattern, negated, directoryOnly: pattern.endsWith("/") };
  });
}

function escapeRegex(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function globRegexBody(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; ) {
    const char = glob[i];
    const next = glob[i + 1];
    const afterNext = glob[i + 2];

    if (char === "*" && next === "*" && afterNext === "/") {
      out += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (char === "*" && next === "*") {
      out += ".*";
      i += 2;
      continue;
    }
    if (char === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }

    out += escapeRegex(char);
    i += 1;
  }
  return out;
}

function matchesSegment(segment: string, pattern: string): boolean {
  return new RegExp(`^${globRegexBody(pattern)}$`).test(segment);
}

function matchesSlashPattern(relativePath: string, pattern: string, directoryOnly: boolean): boolean {
  const cleaned = stripLeadingSlash(pattern).replace(/\/+$/, "");
  if (!cleaned) return false;
  const suffix = directoryOnly ? "(?:/.*)?" : "";
  return new RegExp(`^${globRegexBody(cleaned)}${suffix}$`).test(relativePath);
}

function matchesRule(relativePath: string, rule: IgnoreRule): boolean {
  const pattern = rule.pattern.replace(/\/+$/, "");
  if (!pattern) return false;

  if (pattern.includes("/")) return matchesSlashPattern(relativePath, rule.pattern, rule.directoryOnly);

  const segments = relativePath.split("/").filter(Boolean);
  if (!rule.directoryOnly) return segments.some((segment) => matchesSegment(segment, pattern));

  return segments.some((segment) => matchesSegment(segment, pattern));
}

export function matchIgnoreRules(relativePath: string, rules: readonly IgnoreRule[]): IgnoreRule | undefined {
  let matched: IgnoreRule | undefined;
  let blocked = false;
  for (const rule of rules) {
    if (!matchesRule(relativePath, rule)) continue;
    matched = rule;
    blocked = !rule.negated;
  }
  return blocked ? matched : undefined;
}

async function secretignoreRules(cwd: string): Promise<IgnoreRule[]> {
  const root = await projectRootFor(cwd);
  try {
    const content = await readFile(join(root, SECRETIGNORE_FILE), "utf8");
    return parseIgnoreRules(content);
  } catch {
    return [];
  }
}

function projectRulesAllowed(ctx: any): boolean {
  return ctx?.isProjectTrusted?.() === true;
}

type GuardMatcher = (absolutePath: string) => Promise<GuardMatch | undefined>;

async function createGuardMatcher(ctx: any, settings: ScopedSettings): Promise<GuardMatcher> {
  const cwd = ctx?.cwd ?? process.cwd();
  const root = await projectRootFor(cwd);
  const protectCommon = settings.get("protectCommonSecrets", true);
  const protectSecretignore = settings.get("protectSecretignore", true) && projectRulesAllowed(ctx);
  const protectGitignore = settings.get("protectGitignore", false);
  const projectRules = protectSecretignore ? await secretignoreRules(cwd) : [];

  return async (absolutePath: string) => {
    if (protectCommon) {
      const relativePath = pathForRoot(root, absolutePath);
      const absoluteCandidate = stripLeadingSlash(normalizePath(resolve(absolutePath)));
      const candidates = [relativePath, absoluteCandidate].filter((candidate): candidate is string => Boolean(candidate));
      for (const candidate of candidates) {
        const match = matchIgnoreRules(candidate, COMMON_SECRET_RULES);
        if (match) return { absolutePath, source: "common-secrets", pattern: match.pattern };
      }
    }

    if (projectRules.length) {
      const relativePath = pathForRoot(root, absolutePath);
      if (relativePath) {
        const match = matchIgnoreRules(relativePath, projectRules);
        if (match) return { absolutePath, source: ".secretignore", pattern: match.pattern };
      }
    }

    if (protectGitignore && (await isGitIgnored(cwd, absolutePath))) return { absolutePath, source: ".gitignore" };
    return undefined;
  };
}

export async function guardedPathMatch(ctx: any, absolutePath: string, settings: ScopedSettings): Promise<GuardMatch | undefined> {
  return (await createGuardMatcher(ctx, settings))(absolutePath);
}

function guardSourcesDescription(settings: ScopedSettings): string {
  const sources: string[] = [];
  if (settings.get("protectCommonSecrets", true)) sources.push("common secret patterns");
  if (settings.get("protectSecretignore", true)) sources.push("project .secretignore files");
  if (settings.get("protectGitignore", false)) sources.push("legacy .gitignore rules");
  return sources.length ? sources.join(", ") : "configured guard rules";
}

function reminder(systemPrompt: string, settings: ScopedSettings): string {
  return `${systemPrompt}\n\nSecrets Guard is active. Treat paths matched by ${guardSourcesDescription(settings)} as inaccessible: do not read, list, search, write, edit, summarize, reveal, or infer their contents. Do not use bash or another tool to bypass this guard. If the user asks for guarded content, explain that Secrets Guard blocks access.`;
}

function explicitPathInput(event: any): unknown {
  if (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit") return event.input?.path;
  if (event.toolName === "ls" || event.toolName === "grep" || event.toolName === "find") return event.input?.path;
  return undefined;
}

function protectionEnabled(toolName: string): boolean {
  return toolName === "read" || toolName === "write" || toolName === "edit" || toolName === "ls" || toolName === "grep" || toolName === "find";
}

function unquoteToken(token: string): string {
  return token
    .replace(/^[\'"]|[\'"]$/g, "")
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

async function canonicalWritePath(absolutePath: string): Promise<string> {
  const suffix: string[] = [];
  let current = absolutePath;
  while (true) {
    try {
      return resolve(await realpath(current), ...suffix);
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolutePath;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

async function pathCandidates(cwd: string, rawPath: unknown, forWrite: boolean): Promise<string[]> {
  const lexical = resolveToolPath(cwd, rawPath);
  if (!lexical) return [];
  let canonical = lexical;
  try {
    canonical = await realpath(lexical);
  } catch {
    if (forWrite) canonical = await canonicalWritePath(lexical);
  }
  return [...new Set([lexical, canonical])];
}

async function blockedGuardedPath(ctx: any, rawPath: unknown, settings: ScopedSettings, forWrite = false, matcher?: GuardMatcher): Promise<GuardMatch | undefined> {
  const cwd = ctx?.cwd ?? process.cwd();
  const match = matcher ?? await createGuardMatcher(ctx, settings);
  for (const candidate of await pathCandidates(cwd, rawPath, forWrite)) {
    const blocked = await match(candidate);
    if (blocked) return blocked;
  }
  return undefined;
}

async function guardedDescendantMatch(ctx: any, rawRoot: unknown, recursive: boolean, matcher: GuardMatcher, settings: ScopedSettings): Promise<GuardMatch | undefined> {
  const cwd = ctx?.cwd ?? process.cwd();
  const [root] = await pathCandidates(cwd, rawRoot ?? ".", false);
  if (!root) return undefined;
  try {
    if (!(await stat(root)).isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const queue = [root];
  const visited = new Set<string>();
  while (queue.length) {
    const directory = queue.shift()!;
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(directory);
    } catch {
      continue;
    }
    if (visited.has(canonicalDirectory)) continue;
    visited.add(canonicalDirectory);

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(directory, entry.name);
      const blocked = await blockedGuardedPath(ctx, child, settings, false, matcher);
      if (blocked) return blocked;
      if (recursive && entry.isDirectory() && entry.name !== ".git") queue.push(child);
    }
    if (!recursive) break;
  }
  return undefined;
}

function blockReason(match: GuardMatch): string {
  const source = match.pattern ? `${match.source}: ${match.pattern}` : match.source;
  return `Secrets Guard blocked guarded path (${source}): ${match.absolutePath}`;
}

export function shouldInjectReminder(settings: ScopedSettings): boolean {
  return settings.get("enabled", true);
}

export default function secretsGuard(pi: ExtensionAPI) {
  registerSettingsSection(pi, SECRETS_SETTINGS_SECTION);
  const settings = settingsFor(pi, SETTINGS_ID);
  pi.on("before_agent_start", async (event: any) => {
    if (!shouldInjectReminder(settings)) return;
    return { systemPrompt: reminder(event.systemPrompt ?? "", settings) };
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!settings.get("enabled", true)) return;

    if (event.toolName === "bash") {
      const mode = settings.get<BashGuard>("bashGuard", "best-effort");
      if (mode === "off") return;
      if (mode === "block") return { block: true, reason: "Secrets Guard: bash is blocked by /pip-settings." };
      const command = String(event.input?.command ?? "");
      for (const token of bashPathTokens(command)) {
        const blocked = await blockedGuardedPath(ctx, token, settings);
        if (blocked) return { block: true, reason: blockReason(blocked) };
      }
      return;
    }

    if (!protectionEnabled(event.toolName)) return;
    const matcher = await createGuardMatcher(ctx, settings);
    const searchTool = event.toolName === "ls" || event.toolName === "grep" || event.toolName === "find";
    const rawPath = explicitPathInput(event) ?? (searchTool ? "." : undefined);
    const forWrite = event.toolName === "write" || event.toolName === "edit";
    let blocked = await blockedGuardedPath(ctx, rawPath, settings, forWrite, matcher);
    if (!blocked && searchTool) blocked = await guardedDescendantMatch(ctx, rawPath, event.toolName !== "ls", matcher, settings);
    if (!blocked) return;
    ctx.ui?.notify?.(`Secrets Guard blocked ${event.toolName}: ${blocked.absolutePath}`, "warning");
    return { block: true, reason: blockReason(blocked) };
  });
}

export const __test = {
  COMMON_SECRET_PATTERNS,
  bashPathTokens,
  guardedPathMatch,
  matchIgnoreRules,
  parseIgnoreRules,
  pathForGit,
  pathForRoot,
  reminder,
  resolveToolPath,
};
