import { rmSync } from "node:fs";
import { basename } from "node:path";
import { dayKey, mergeRollups } from "./rollups.ts";
import { aggregateEventDir, claimEventDayForCompaction, listClaimedEventDirs, listEventDays } from "./events.ts";
import { readDailyUsage, writeDailyUsage } from "./daily.ts";
import { withUsageMaintenanceLock } from "./locks.ts";

function finalizeClaimedEventDir(day: string, claimedDir: string): void {
  const source = basename(claimedDir);
  const existing = readDailyUsage(day);
  if (existing.compactedEventSources?.includes(source)) {
    rmSync(claimedDir, { recursive: true, force: true });
    return;
  }

  const rollups = aggregateEventDir(claimedDir);
  // Merge with an existing daily file so compatibility imports and event compaction can coexist.
  // Source markers make retry after crash idempotent.
  mergeRollups(rollups, existing);
  rollups.compactedEventSources = Array.from(new Set([...(existing.compactedEventSources ?? []), source]));
  rollups.migratedLegacySources = existing.migratedLegacySources;
  writeDailyUsage(day, rollups);
  rmSync(claimedDir, { recursive: true, force: true });
}

export function compactPastEventDays(now = Date.now()): void {
  const today = dayKey(now);
  const days = listEventDays().filter((day) => day < today);
  const claimed = listClaimedEventDirs();
  if (days.length === 0 && claimed.length === 0) return;

  withUsageMaintenanceLock(() => {
    for (const dir of claimed) finalizeClaimedEventDir(dir.day, dir.path);
    for (const day of days) {
      const claimedDir = claimEventDayForCompaction(day);
      if (!claimedDir) continue;
      finalizeClaimedEventDir(day, claimedDir);
    }
  });
}
