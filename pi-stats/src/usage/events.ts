import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { normalizeUsage } from "../../../pip-common/index.ts";
import { pipPath } from "../../../pip-common/index.ts";
import { addEventToRollups, dayKey, emptyRollups, mergeRollups } from "./rollups.ts";
import type { GlobalUsageEvent, UsageRollups } from "./types.ts";

export const EVENT_USAGE_DIR = pipPath("usage", "events");

const EVENT_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMPACTING_DAY_RE = /^(\d{4}-\d{2}-\d{2})\.compacting\.\d+\.\d+$/;

function safeFilePart(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

export function eventDayDir(day: string): string {
  return join(EVENT_USAGE_DIR, day);
}

export function eventSessionPath(event: GlobalUsageEvent): string {
  const day = dayKey(event.ts || Date.now());
  const sessionKey = event.sessionFile || event.cwd || "unknown-session";
  return join(eventDayDir(day), `${safeFilePart(sessionKey)}-${process.pid}.jsonl`);
}

export function appendUsageEvent(event: GlobalUsageEvent): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const path = eventSessionPath(event);
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(event) + "\n", "utf8");
      return;
    } catch (error: any) {
      lastError = error;
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw lastError;
}

function hasInvalidStoredUsageField(value: any): boolean {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "cache", "total", "cost"]) {
    if (!(key in value)) continue;
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) return true;
  }
  return false;
}

export function normalizeUsageEvent(value: any): GlobalUsageEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.ts !== "number" || !Number.isFinite(value.ts)) return undefined;
  if (typeof value.provider !== "string" || !value.provider) return undefined;
  if (typeof value.model !== "string" || !value.model) return undefined;
  if (hasInvalidStoredUsageField(value)) return undefined;
  const usage = normalizeUsage(value);
  if (!usage || usage.total <= 0) return undefined;
  const kind = ["assistant", "tool", "compaction", "branch_summary"].includes(value.kind) ? value.kind : undefined;
  return {
    ...(typeof value.id === "string" && value.id ? { id: value.id } : {}),
    ...(kind ? { kind } : {}),
    ts: value.ts,
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(typeof value.sessionFile === "string" ? { sessionFile: value.sessionFile } : {}),
    provider: value.provider,
    model: value.model,
    ...usage,
  };
}

export function readEventFile(path: string, seenIds = new Set<string>()): UsageRollups {
  const rollups = emptyRollups();
  if (!existsSync(path)) return rollups;
  const lines = readFileSync(path, "utf8").split("\n");
  for (const line of lines) {
    if (!line) continue;
    try {
      const event = normalizeUsageEvent(JSON.parse(line));
      if (!event) continue;
      if (event.id) {
        if (seenIds.has(event.id)) continue;
        seenIds.add(event.id);
      }
      addEventToRollups(rollups, event);
    } catch {}
  }
  return rollups;
}

export function aggregateEventDir(dir: string, seenIds = new Set<string>()): UsageRollups {
  const rollups = emptyRollups();
  if (!existsSync(dir)) return rollups;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    mergeRollups(rollups, readEventFile(join(dir, entry.name), seenIds));
  }
  return rollups;
}

export function aggregateEventDay(day: string, seenIds = new Set<string>()): UsageRollups {
  return aggregateEventDir(eventDayDir(day), seenIds);
}

export function claimEventDayForCompaction(day: string): string | undefined {
  const dir = eventDayDir(day);
  if (!existsSync(dir)) return undefined;
  const claimed = join(EVENT_USAGE_DIR, `${day}.compacting.${process.pid}.${Date.now()}`);
  try {
    renameSync(dir, claimed);
    return claimed;
  } catch {
    return undefined;
  }
}

export function listEventDays(): string[] {
  if (!existsSync(EVENT_USAGE_DIR)) return [];
  return readdirSync(EVENT_USAGE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => EVENT_DAY_RE.test(name))
    .sort();
}

export function listClaimedEventDirs(): Array<{ day: string; path: string }> {
  if (!existsSync(EVENT_USAGE_DIR)) return [];
  const dirs: Array<{ day: string; path: string }> = [];
  for (const entry of readdirSync(EVENT_USAGE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(COMPACTING_DAY_RE);
    if (!match) continue;
    dirs.push({ day: match[1], path: join(EVENT_USAGE_DIR, entry.name) });
  }
  return dirs.sort((a, b) => a.path.localeCompare(b.path));
}

export function readAllEventUsage(compactedSources = new Set<string>()): UsageRollups {
  const rollups = emptyRollups();
  const seenIds = new Set<string>();
  for (const day of listEventDays()) mergeRollups(rollups, aggregateEventDay(day, seenIds));
  for (const dir of listClaimedEventDirs()) {
    if (compactedSources.has(basename(dir.path))) continue;
    mergeRollups(rollups, aggregateEventDir(dir.path, seenIds));
  }
  return rollups;
}
