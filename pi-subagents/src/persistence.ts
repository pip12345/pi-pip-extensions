import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pipPath } from "pip-common";
import type { RunStatus, SubagentEvent, SubagentRun } from "./types.ts";
import { privateSessionDir } from "./runner.ts";

const VERSION = 2;

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
  version: 2;
  id: string;
  name?: string;
  agent: string;
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
  resultText?: string;
  errorText?: string;
  events: SubagentEvent[];
}

interface ParentIndex {
  version: 2;
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
    events: run.events.slice(-300).map((event) => ({ ...event })),
  };
}

export function restoredRun(record: PersistedRun, now: number): SubagentRun {
  const wasRunning = record.status === "running";
  return {
    id: record.id,
    name: record.name,
    agent: record.agent,
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
    events: record.events.slice(-300).map((event) => ({ ...event })),
    abortController: new AbortController(),
    forwarding: false,
  };
}

function validateIndex(value: any, expectedParentKey: string): ParentIndex {
  if (!value || value.version !== VERSION || value.parentSessionKey !== expectedParentKey || typeof value.parentSessionFile !== "string" || !Array.isArray(value.runs)) {
    throw new Error(`Invalid subagent persistence index for parent ${expectedParentKey}`);
  }
  return value as ParentIndex;
}

export function readParentRuns(parentSessionKey: string, baseDir?: string): { parentSessionFile: string; runs: PersistedRun[] } | undefined {
  const path = parentIndexPath(parentSessionKey, baseDir);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const index = validateIndex(parsed, parentSessionKey);
  return { parentSessionFile: index.parentSessionFile, runs: index.runs };
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
      index = validateIndex(parsed, parsed?.parentSessionKey);
    } catch {
      continue;
    }
    if (activeParentSessionFile && index.parentSessionFile === activeParentSessionFile) continue;
    if (existsSync(index.parentSessionFile)) continue;
    for (const run of index.runs) deleteManagedChildSession(index.parentSessionKey, run.sessionFile);
    rmSync(join(root, entry.name), { recursive: true, force: true });
  }
}
