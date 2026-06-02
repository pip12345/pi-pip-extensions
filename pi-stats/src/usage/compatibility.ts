import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { pipPath } from "../../../pip-common/index.ts";
import { addEventToRollups, emptyRollups, mergeRollups } from "./rollups.ts";
import type { GlobalUsageEvent, UsageRollups } from "./types.ts";

export const LEGACY_ROOT_USAGE_PATH = pipPath("token-usage.json");
export const LEGACY_GLOBAL_USAGE_PATH = pipPath("token-usage.jsonl");

export interface MigrationStore {
  readRollupsFile(): UsageRollups;
  writeRollupsFile(rollups: UsageRollups): void;
}

function readLegacyGlobalEvents(): GlobalUsageEvent[] {
  if (!existsSync(LEGACY_GLOBAL_USAGE_PATH)) return [];
  const lines = readFileSync(LEGACY_GLOBAL_USAGE_PATH, "utf8").split("\n").filter(Boolean);
  const events: GlobalUsageEvent[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event?.model && typeof event.ts === "number") events.push(event);
    } catch {}
  }
  return events;
}

function readLegacyRootRollups(): UsageRollups {
  if (!existsSync(LEGACY_ROOT_USAGE_PATH)) return emptyRollups();
  try {
    const parsed = JSON.parse(readFileSync(LEGACY_ROOT_USAGE_PATH, "utf8"));
    if (parsed?.version === 1 && parsed?.buckets && typeof parsed.buckets === "object") return parsed;
  } catch {}
  return emptyRollups();
}

export function migrateLegacyUsage(store: MigrationStore): void {
  if (!existsSync(LEGACY_GLOBAL_USAGE_PATH) && !existsSync(LEGACY_ROOT_USAGE_PATH)) return;
  const rollups = store.readRollupsFile();
  mergeRollups(rollups, readLegacyRootRollups());
  for (const event of readLegacyGlobalEvents()) addEventToRollups(rollups, event);
  store.writeRollupsFile(rollups);
  if (existsSync(LEGACY_ROOT_USAGE_PATH)) unlinkSync(LEGACY_ROOT_USAGE_PATH);
  if (existsSync(LEGACY_GLOBAL_USAGE_PATH)) unlinkSync(LEGACY_GLOBAL_USAGE_PATH);
}
