import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pipPath } from "../../../pip-common/index.ts";
import { addEventToRollups, emptyRollups, mergeRollups, normalizeUsageRollups } from "./rollups.ts";
import { readDailyUsage, writeDailyUsage } from "./daily.ts";
import { normalizeUsageEvent } from "./events.ts";
import { withUsageMaintenanceLock } from "./locks.ts";
import type { UsageBucket, UsageRollups } from "./types.ts";

export const LEGACY_ROOT_USAGE_PATH = pipPath("token-usage.json");
export const LEGACY_GLOBAL_USAGE_PATH = pipPath("token-usage.jsonl");
export const LEGACY_USAGE_ROLLUP_PATH = pipPath("usage", "token-usage.json");

const MIGRATING_RE = /\.migrating\.\d+\.\d+$/;

function claimLegacyFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const claimed = `${path}.migrating.${process.pid}.${Date.now()}`;
  try {
    renameSync(path, claimed);
    return claimed;
  } catch {
    return undefined;
  }
}

function listClaimedLegacyFiles(): string[] {
  const dirs = Array.from(new Set([dirname(LEGACY_ROOT_USAGE_PATH), dirname(LEGACY_USAGE_ROLLUP_PATH)]));
  const files: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !MIGRATING_RE.test(entry.name)) continue;
      const original = entry.name.replace(MIGRATING_RE, "");
      if (!["token-usage.json", "token-usage.jsonl"].includes(original)) continue;
      files.push(join(dir, entry.name));
    }
  }
  return files.sort();
}

function readLegacyGlobalEvents(path: string): UsageRollups {
  const rollups = emptyRollups();
  if (!existsSync(path)) return rollups;
  const seenIds = new Set<string>();
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
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

function readLegacyRollups(path: string): UsageRollups {
  if (!existsSync(path)) return emptyRollups();
  try {
    return normalizeUsageRollups(JSON.parse(readFileSync(path, "utf8")));
  } catch {}
  return emptyRollups();
}

function readClaimedLegacyFile(path: string): UsageRollups {
  const originalName = basename(path).replace(MIGRATING_RE, "");
  return originalName === "token-usage.jsonl" ? readLegacyGlobalEvents(path) : readLegacyRollups(path);
}

function splitRollupsByDay(rollups: UsageRollups): Map<string, UsageRollups> {
  const byDay = new Map<string, UsageRollups>();
  for (const bucket of Object.values(rollups.buckets) as UsageBucket[]) {
    if (!bucket?.day) continue;
    const daily = byDay.get(bucket.day) ?? emptyRollups();
    daily.buckets[`${bucket.day}|${bucket.provider}|${bucket.model}`] = { ...bucket };
    byDay.set(bucket.day, daily);
  }
  return byDay;
}

function writeClaimedLegacyAsDaily(sourcePath: string): void {
  const source = basename(sourcePath);
  const rollups = readClaimedLegacyFile(sourcePath);
  const byDay = splitRollupsByDay(rollups);
  for (const [day, daily] of byDay) {
    const existing = readDailyUsage(day);
    if (existing.migratedLegacySources?.includes(source)) continue;
    mergeRollups(daily, existing);
    daily.compactedEventSources = existing.compactedEventSources;
    daily.migratedLegacySources = Array.from(new Set([...(existing.migratedLegacySources ?? []), source]));
    writeDailyUsage(day, daily);
  }
  rmSync(sourcePath, { force: true });
}

export function migrateLegacyUsage(): void {
  const hasLegacyRoot = existsSync(LEGACY_ROOT_USAGE_PATH);
  const hasLegacyJsonl = existsSync(LEGACY_GLOBAL_USAGE_PATH);
  const hasLegacyUsageRollup = existsSync(LEGACY_USAGE_ROLLUP_PATH);
  const hasClaimed = listClaimedLegacyFiles().length > 0;
  if (!hasLegacyRoot && !hasLegacyJsonl && !hasLegacyUsageRollup && !hasClaimed) return;

  withUsageMaintenanceLock(() => {
    const claimed = [
      ...listClaimedLegacyFiles(),
      claimLegacyFile(LEGACY_ROOT_USAGE_PATH),
      claimLegacyFile(LEGACY_GLOBAL_USAGE_PATH),
      claimLegacyFile(LEGACY_USAGE_ROLLUP_PATH),
    ].filter((path): path is string => !!path);

    for (const path of claimed) writeClaimedLegacyAsDaily(path);
  });
}
