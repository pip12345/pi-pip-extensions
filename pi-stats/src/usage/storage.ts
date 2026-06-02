import { compactPastEventDays } from "./compaction.ts";
import { readAllDailyUsage } from "./daily.ts";
import { appendUsageEvent, readAllEventUsage } from "./events.ts";
import { migrateLegacyUsage } from "./compatibility.ts";
import { emptyRollups, mergeRollups } from "./rollups.ts";
import type { GlobalUsageEvent, UsageRollups } from "./types.ts";

export function initializeUsageStorage(): void {
  migrateLegacyUsage();
  compactPastEventDays();
}

export function migrateUsageStorage(): void {
  migrateLegacyUsage();
}

function sourceMarkerKey(rollups: UsageRollups): string {
  return JSON.stringify([...(rollups.compactedEventSources ?? [])].sort());
}

function combineRollups(daily: UsageRollups): UsageRollups {
  const rollups = emptyRollups();
  mergeRollups(rollups, daily);
  mergeRollups(rollups, readAllEventUsage(new Set(daily.compactedEventSources ?? [])));
  rollups.updatedAt = Date.now();
  return rollups;
}

export function readRollupsFile(): UsageRollups {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = readAllDailyUsage();
    const combined = combineRollups(before);
    const after = readAllDailyUsage();
    if (sourceMarkerKey(before) === sourceMarkerKey(after)) return combined;
  }
  return combineRollups(readAllDailyUsage());
}

export function readRollups(): UsageRollups {
  migrateUsageStorage();
  compactPastEventDays();
  return readRollupsFile();
}

export function updateRollups(event: GlobalUsageEvent): void {
  appendUsageEvent(event);
}
