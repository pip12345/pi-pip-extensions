import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pipPath } from "../../../pip-common/index.ts";
import { migrateLegacyUsage } from "./compatibility.ts";
import { addEventToRollups, emptyRollups } from "./rollups.ts";
import type { GlobalUsageEvent, UsageRollups } from "./types.ts";

export const GLOBAL_USAGE_PATH = pipPath("usage", "token-usage.json");

export function readRollupsFile(): UsageRollups {
  if (!existsSync(GLOBAL_USAGE_PATH)) return emptyRollups();
  try {
    const parsed = JSON.parse(readFileSync(GLOBAL_USAGE_PATH, "utf8"));
    if (parsed?.version === 1 && parsed?.buckets && typeof parsed.buckets === "object") return parsed;
  } catch {}
  return emptyRollups();
}

export function writeRollupsFile(rollups: UsageRollups): void {
  mkdirSync(dirname(GLOBAL_USAGE_PATH), { recursive: true });
  rollups.updatedAt = Date.now();
  const tmp = `${GLOBAL_USAGE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(rollups, null, 2) + "\n", "utf8");
  renameSync(tmp, GLOBAL_USAGE_PATH);
}

const migrationStore = { readRollupsFile, writeRollupsFile };

export function migrateUsageStorage(): void {
  migrateLegacyUsage(migrationStore);
}

export function readRollups(): UsageRollups {
  migrateUsageStorage();
  return readRollupsFile();
}

export function updateRollups(event: GlobalUsageEvent): void {
  migrateUsageStorage();
  const rollups = readRollupsFile();
  addEventToRollups(rollups, event);
  writeRollupsFile(rollups);
}
