import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { emptyUsage, pipPath, type TokenUsage } from "pip-common";
import type { RunStatus, SubagentEvent, SubagentRun } from "./types.ts";
import { isSafeRunId } from "./context.ts";
import { privateSessionDir } from "./runner.ts";

const VERSION = 3;

function safePart(value: string): string {
  const slug = value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "unknown";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

export function parentsDir(baseDir = pipPath("subagents", "parents")): string {
  return baseDir;
}

export function parentDir(parentSessionKey: string, baseDir?: string): string {
  return join(parentsDir(baseDir), safePart(parentSessionKey));
}

export function parentIndexPath(parentSessionKey: string, baseDir?: string): string {
  return join(parentDir(parentSessionKey, baseDir), "runs.json");
}

export interface PersistedRun {
  version: 2 | 3;
  id: string;
  name?: string;
  agent: string;
  model?: string;
  prompt: string;
  cwd: string;
  parentSessionKey: string;
  parentSessionFile: string;
  keep: boolean;
  anchorEntryId?: string;
  background: boolean;
  detached: boolean;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  sessionFile?: string;
  contextRoot?: string;
  runContextDir?: string;
  resultText?: string;
  errorText?: string;
  usage?: TokenUsage;
  events: SubagentEvent[];
}

interface ParentIndex {
  version: 2 | 3;
  parentSessionKey: string;
  parentSessionFile: string;
  runs: PersistedRun[];
}

export function canPersist(run: SubagentRun): run is SubagentRun & { parentSessionFile: string } {
  return typeof run.parentSessionFile === "string" && run.parentSessionFile.length > 0;
}

export function toPersistedRun(run: SubagentRun): PersistedRun | undefined {
  if (!canPersist(run)) return undefined;
  return {
    version: VERSION,
    id: run.id,
    name: run.name,
    agent: run.agent,
    model: run.model,
    prompt: run.prompt,
    cwd: run.cwd,
    parentSessionKey: run.parentSessionKey,
    parentSessionFile: run.parentSessionFile,
    keep: run.keep,
    anchorEntryId: run.anchorEntryId,
    background: run.background,
    detached: run.detached,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    sessionFile: run.sessionFile,
    resultText: run.resultText,
    errorText: run.errorText,
    usage: { ...run.usage },
    events: run.events.slice(-300).map((event) => ({ ...event })),
  };
}

export function restoredRun(record: PersistedRun, now: number): SubagentRun {
  const wasRunning = record.status === "running";
  return {
    id: record.id,
    name: record.name,
    agent: record.agent,
    model: record.model,
    prompt: record.prompt,
    cwd: record.cwd,
    parentSessionKey: record.parentSessionKey,
    parentSessionFile: record.parentSessionFile,
    keep: record.keep,
    anchorEntryId: record.anchorEntryId,
    background: false,
    detached: true,
    status: wasRunning ? "interrupted" : record.status,
    createdAt: record.createdAt,
    updatedAt: wasRunning ? now : record.updatedAt,
    completedAt: wasRunning ? now : record.completedAt,
    sessionFile: record.sessionFile,
    resultText: record.resultText,
    errorText: wasRunning ? "Subagent was interrupted by parent process shutdown/restart." : record.errorText,
    usage: { ...(record.usage ?? emptyUsage()) },
    events: record.events.slice(-300).map((event) => ({ ...event })),
    abortController: new AbortController(),
    forwarding: false,
  };
}

const RUN_STATUSES = new Set<RunStatus>(["running", "completed", "error", "cancelled", "interrupted"]);

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function validUsage(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return ["input", "output", "cacheRead", "cacheWrite", "cache", "total", "cost"].every((key) => typeof usage[key] === "number" && Number.isFinite(usage[key]));
}

function validEvent(value: unknown): value is SubagentEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (typeof event.at !== "number" || !Number.isFinite(event.at)) return false;
  if (event.type === "steer" || event.type === "text_delta") return typeof event.text === "string";
  if (event.type === "tool_start") return typeof event.id === "string" && typeof event.name === "string" && typeof event.argsSummary === "string";
  if (event.type === "tool_end") {
    return typeof event.id === "string" && typeof event.ok === "boolean" && optionalString(event.resultSummary) && optionalNumber(event.durationMs);
  }
  return false;
}

function validPersistedRun(value: unknown, index: ParentIndex): value is PersistedRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Record<string, unknown>;
  return (
    (run.version === 2 || run.version === VERSION) &&
    isSafeRunId(run.id) &&
    typeof run.agent === "string" && run.agent.length > 0 &&
    typeof run.prompt === "string" &&
    typeof run.cwd === "string" && run.cwd.length > 0 &&
    run.parentSessionKey === index.parentSessionKey &&
    run.parentSessionFile === index.parentSessionFile &&
    typeof run.keep === "boolean" &&
    typeof run.background === "boolean" &&
    typeof run.detached === "boolean" &&
    typeof run.status === "string" && RUN_STATUSES.has(run.status as RunStatus) &&
    typeof run.createdAt === "number" && Number.isFinite(run.createdAt) &&
    typeof run.updatedAt === "number" && Number.isFinite(run.updatedAt) &&
    optionalNumber(run.completedAt) &&
    optionalString(run.name) &&
    optionalString(run.model) &&
    optionalString(run.anchorEntryId) &&
    optionalString(run.sessionFile) &&
    optionalString(run.contextRoot) &&
    optionalString(run.runContextDir) &&
    optionalString(run.resultText) &&
    optionalString(run.errorText) &&
    validUsage(run.usage) &&
    Array.isArray(run.events) && run.events.every(validEvent)
  );
}

function validateIndex(value: unknown, expectedParentKey: string): { index: ParentIndex; invalidRuns: boolean } {
  if (!value || typeof value !== "object") throw new Error(`Invalid subagent persistence index for parent ${expectedParentKey}`);
  const raw = value as Record<string, unknown>;
  if ((raw.version !== 2 && raw.version !== VERSION) || raw.parentSessionKey !== expectedParentKey || typeof raw.parentSessionFile !== "string" || !raw.parentSessionFile || !Array.isArray(raw.runs)) {
    throw new Error(`Invalid subagent persistence index for parent ${expectedParentKey}`);
  }
  const index = raw as unknown as ParentIndex;
  const runs = index.runs.filter((run) => validPersistedRun(run, index));
  return { index: { ...index, runs }, invalidRuns: runs.length !== index.runs.length };
}

function quarantineIndex(path: string, parentSessionKey: string, baseDir?: string): void {
  const target = join(parentsDir(baseDir), `${safePart(parentSessionKey)}.invalid.${Date.now()}.${process.pid}.json`);
  try { renameSync(path, target); } catch {}
}

export function readParentRuns(parentSessionKey: string, baseDir?: string): { parentSessionFile: string; runs: PersistedRun[] } | undefined {
  const path = parentIndexPath(parentSessionKey, baseDir);
  if (!existsSync(path)) return undefined;
  try {
    const { index, invalidRuns } = validateIndex(JSON.parse(readFileSync(path, "utf8")), parentSessionKey);
    if (invalidRuns) quarantineIndex(path, parentSessionKey, baseDir);
    return { parentSessionFile: index.parentSessionFile, runs: index.runs };
  } catch {
    quarantineIndex(path, parentSessionKey, baseDir);
    return undefined;
  }
}

export function writeParentRuns(parentSessionKey: string, parentSessionFile: string, runs: PersistedRun[], baseDir?: string): void {
  const dir = parentDir(parentSessionKey, baseDir);
  if (!runs.length) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  mkdirSync(dir, { recursive: true });
  const index: ParentIndex = { version: VERSION, parentSessionKey, parentSessionFile, runs };
  const target = join(dir, "runs.json");
  const tmp = join(dir, `runs.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(index, null, 2));
  renameSync(tmp, target);
}

export function deleteParentPersistence(parentSessionKey: string, baseDir?: string): void {
  rmSync(parentDir(parentSessionKey, baseDir), { recursive: true, force: true });
}

export function deleteManagedChildSession(parentSessionKey: string, sessionFile: string | undefined): void {
  if (!sessionFile) return;
  const allowedDir = resolve(privateSessionDir(parentSessionKey));
  const target = resolve(sessionFile);
  const rel = relative(allowedDir, target);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return;
  rmSync(target, { force: true });
  try { rmSync(dirname(sessionFile), { recursive: false }); } catch {}
}

export function gcOrphanedParents(activeParentSessionFile?: string, baseDir?: string): void {
  const root = parentsDir(baseDir);
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const indexPath = join(root, entry.name, "runs.json");
    if (!existsSync(indexPath)) continue;
    let index: ParentIndex;
    try {
      const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
      const validated = validateIndex(parsed, parsed?.parentSessionKey);
      if (validated.invalidRuns) {
        quarantineIndex(indexPath, validated.index.parentSessionKey, baseDir);
        continue;
      }
      index = validated.index;
    } catch {
      continue;
    }
    if (activeParentSessionFile && index.parentSessionFile === activeParentSessionFile) continue;
    if (existsSync(index.parentSessionFile)) continue;
    for (const run of index.runs) deleteManagedChildSession(index.parentSessionKey, run.sessionFile);
    rmSync(join(root, entry.name), { recursive: true, force: true });
  }
}
