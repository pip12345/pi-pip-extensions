import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipPath } from "../../../pip-common/index.ts";
import { emptyRollups, mergeRollups, normalizeUsageRollups } from "./rollups.ts";
import type { UsageRollups } from "./types.ts";

export const DAILY_USAGE_DIR = pipPath("usage", "daily");

export function dailyUsagePath(day: string): string {
  return join(DAILY_USAGE_DIR, `${day}.json`);
}

export function readDailyUsage(day: string): UsageRollups {
  const path = dailyUsagePath(day);
  if (!existsSync(path)) return emptyRollups();
  try {
    return normalizeUsageRollups(JSON.parse(readFileSync(path, "utf8")));
  } catch {}
  return emptyRollups();
}

export function writeDailyUsage(day: string, rollups: UsageRollups): void {
  mkdirSync(dirname(dailyUsagePath(day)), { recursive: true });
  rollups.updatedAt = Date.now();
  const path = dailyUsagePath(day);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(rollups, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function readAllDailyUsage(): UsageRollups {
  const rollups = emptyRollups();
  if (!existsSync(DAILY_USAGE_DIR)) return rollups;
  const compactedEventSources = new Set<string>();
  const migratedLegacySources = new Set<string>();
  for (const entry of readdirSync(DAILY_USAGE_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const daily = readDailyUsage(entry.name.slice(0, -".json".length));
    mergeRollups(rollups, daily);
    for (const source of daily.compactedEventSources ?? []) compactedEventSources.add(source);
    for (const source of daily.migratedLegacySources ?? []) migratedLegacySources.add(source);
  }
  if (compactedEventSources.size > 0) rollups.compactedEventSources = Array.from(compactedEventSources);
  if (migratedLegacySources.size > 0) rollups.migratedLegacySources = Array.from(migratedLegacySources);
  return rollups;
}

export function removeDailyUsage(day: string): void {
  rmSync(dailyUsagePath(day), { force: true });
}
