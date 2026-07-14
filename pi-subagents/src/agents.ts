import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, AgentDiagnostic, AgentDiscoveryResult, AgentSource, AgentTools } from "./types.ts";

const BUILTIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

export const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export function parseToolsField(raw: unknown): AgentTools {
  if (raw == null || raw === "") return "all";
  if (Array.isArray(raw)) return raw.map(String).map((x) => x.trim()).filter(Boolean);
  const value = String(raw).trim();
  if (!value) return "all";
  const lower = value.toLowerCase();
  if (lower === "all" || lower === "none" || lower === "builtins" || lower === "builtin") return lower === "builtin" ? "builtins" : (lower as AgentTools);
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length ? items : "all";
}

export function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return { data: {}, body: content };
  const normalized = content.replace(/\r\n/g, "\n");
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return { data: {}, body: content };
  const raw = normalized.slice(4, end);
  const data: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf(":");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['\"]|['\"]$/g, "");
    data[key] = value;
  }
  return { data, body: normalized.slice(end + 5).trim() };
}

function loadDir(dir: string, source: AgentSource): { agents: AgentConfig[]; diagnostics: AgentDiagnostic[] } {
  const agents: AgentConfig[] = [];
  const diagnostics: AgentDiagnostic[] = [];
  if (!existsSync(dir)) return { agents, diagnostics };
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({ path: dir, message: error instanceof Error ? error.message : String(error) });
    return { agents, diagnostics };
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    const filePath = join(dir, entry.name);
    try {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (entry.isSymbolicLink() && !statSync(filePath).isFile()) continue;
      const { data, body } = parseFrontmatter(readFileSync(filePath, "utf8"));
      const name = (data.name?.trim() || basename(entry.name, ".md")).trim();
      const description = data.description?.trim();
      if (!name) throw new Error("missing agent name");
      if (!description) throw new Error("missing required description frontmatter");
      agents.push({
        name,
        description,
        model: data.model?.trim() || undefined,
        tools: parseToolsField(data.tools),
        systemPrompt: body.trim(),
        source,
        filePath,
      });
    } catch (error) {
      diagnostics.push({ path: filePath, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { agents, diagnostics };
}

function nearest(cwd: string, rel: string): string | undefined {
  let current = cwd;
  while (true) {
    const candidate = join(current, rel);
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {}
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export interface AgentDiscoveryOptions {
  projectTrusted?: boolean;
}

export function agentSearchDirs(cwd: string, options: AgentDiscoveryOptions = {}): Array<{ dir: string; source: AgentSource }> {
  const dirs: Array<{ dir: string; source: AgentSource }> = [
    { dir: BUILTIN_DIR, source: "builtin" },
    { dir: join(homedir(), ".pi", "agent", "agents"), source: "user" },
  ];
  if (options.projectTrusted === true) {
    const legacyDir = nearest(cwd, ".agents");
    const projectDir = nearest(cwd, join(".pi", "agents"));
    if (legacyDir) dirs.push({ dir: legacyDir, source: "legacy" });
    if (projectDir) dirs.push({ dir: projectDir, source: "project" });
  }
  return dirs;
}

export function discoverAgents(cwd: string, options: AgentDiscoveryOptions = {}): AgentDiscoveryResult {
  const byName = new Map<string, AgentConfig>();
  const diagnostics: AgentDiagnostic[] = [];
  for (const item of agentSearchDirs(cwd, options)) {
    const loaded = loadDir(item.dir, item.source);
    diagnostics.push(...loaded.diagnostics);
    for (const agent of loaded.agents) byName.set(agent.name, agent);
  }
  return { agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
}

export function formatAgent(agent: AgentConfig): string {
  return [
    `agent: ${agent.name}`,
    `source: ${agent.source}`,
    `file: ${agent.filePath}`,
    `description: ${agent.description}`,
    agent.model ? `model: ${agent.model}` : "model: <parent/current>",
    `tools: ${Array.isArray(agent.tools) ? agent.tools.join(", ") : agent.tools}`,
    "",
    "--- prompt ---",
    agent.systemPrompt || "(empty)",
  ].join("\n");
}

export const AGENT_TEMPLATE = `---
description: What this agent is good at and when to use it
# optional: model: provider/model-id
# optional: tools: all | none | builtins | read, grep, find, ls, bash
---

Write the subagent system prompt here. The caller must pass all task context in the prompt.
`;
