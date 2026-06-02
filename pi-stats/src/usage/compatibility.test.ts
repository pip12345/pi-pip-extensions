import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadStorage() {
  vi.resetModules();
  return await import("./storage.ts");
}

function legacyUsageRollupPath(home: string) {
  return join(home, ".pi", "agent", "pip", "usage", "token-usage.json");
}

function dailyPath(home: string, day: string) {
  return join(home, ".pi", "agent", "pip", "usage", "daily", `${day}.json`);
}

function legacyRootUsagePath(home: string) {
  return join(home, ".pi", "agent", "pip", "token-usage.json");
}

function legacyUsagePath(home: string) {
  return join(home, ".pi", "agent", "pip", "token-usage.jsonl");
}

function maintenanceLockDir(home: string) {
  return join(home, ".pi", "agent", "pip", "usage", ".maintenance.lock");
}

function legacyRollup() {
  return {
    version: 1,
    updatedAt: Date.UTC(2026, 5, 1, 14),
    buckets: {
      "2026-06-01|anthropic|claude-sonnet": {
        day: "2026-06-01",
        provider: "anthropic",
        model: "claude-sonnet",
        turns: 2,
        input: 13,
        output: 7,
        cacheRead: 1,
        cacheWrite: 4,
        cache: 5,
        total: 25,
        cost: 0.03,
        firstTs: Date.UTC(2026, 5, 1, 12),
        lastTs: Date.UTC(2026, 5, 1, 13),
      },
    },
  };
}

describe("pi-stats usage compatibility", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pi-stats-usage-"));
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("migrates legacy root rollup usage into a daily summary and removes the old file", async () => {
    const dir = join(home, ".pi", "agent", "pip");
    mkdirSync(dir, { recursive: true });
    writeFileSync(legacyRootUsagePath(home), JSON.stringify(legacyRollup(), null, 2) + "\n", "utf8");

    const { migrateUsageStorage } = await loadStorage();
    migrateUsageStorage();

    const saved = JSON.parse(readFileSync(dailyPath(home, "2026-06-01"), "utf8"));
    expect(saved.buckets["2026-06-01|anthropic|claude-sonnet"]).toMatchObject({
      turns: 2,
      input: 13,
      output: 7,
      cacheRead: 1,
      cacheWrite: 4,
      cache: 5,
      total: 25,
      cost: 0.03,
    });
    expect(existsSync(legacyRootUsagePath(home))).toBe(false);
  });

  it("recovers a dead-owner maintenance lock and migrates legacy usage", async () => {
    const dir = join(home, ".pi", "agent", "pip");
    mkdirSync(dir, { recursive: true });
    mkdirSync(maintenanceLockDir(home), { recursive: true });
    writeFileSync(join(maintenanceLockDir(home), "owner.json"), JSON.stringify({ token: "dead", pid: 99999999, hostname: hostname(), createdAt: 1 }), "utf8");
    writeFileSync(legacyRootUsagePath(home), JSON.stringify(legacyRollup(), null, 2) + "\n", "utf8");

    const { migrateUsageStorage } = await loadStorage();
    migrateUsageStorage();

    const saved = JSON.parse(readFileSync(dailyPath(home, "2026-06-01"), "utf8"));
    expect(saved.buckets["2026-06-01|anthropic|claude-sonnet"]).toMatchObject({ turns: 2, total: 25 });
    expect(existsSync(maintenanceLockDir(home))).toBe(false);
  });

  it("migrates legacy JSONL usage into a daily summary and removes the old file", async () => {
    const dir = join(home, ".pi", "agent", "pip");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      legacyUsagePath(home),
      [
        JSON.stringify({ id: "a", ts: Date.UTC(2026, 5, 1, 12), provider: "anthropic", model: "claude-sonnet", input: 10, output: 5, cacheRead: 1, cacheWrite: 0, cache: 1, total: 16, cost: 0.01 }),
        JSON.stringify({ id: "b", ts: Date.UTC(2026, 5, 1, 13), provider: "anthropic", model: "claude-sonnet", input: 3, output: 2, cacheRead: 0, cacheWrite: 4, cache: 4, total: 9, cost: 0.02 }),
      ].join("\n") + "\n",
      "utf8"
    );

    const { migrateUsageStorage } = await loadStorage();
    migrateUsageStorage();

    const saved = JSON.parse(readFileSync(dailyPath(home, "2026-06-01"), "utf8"));
    expect(saved.buckets["2026-06-01|anthropic|claude-sonnet"]).toMatchObject({
      turns: 2,
      input: 13,
      output: 7,
      cacheRead: 1,
      cacheWrite: 4,
      cache: 5,
      total: 25,
      cost: 0.03,
    });
    expect(existsSync(legacyRootUsagePath(home))).toBe(false);
    expect(existsSync(legacyUsagePath(home))).toBe(false);
  });

  it("does not double-count a claimed legacy source that was already written before a crash", async () => {
    const dir = join(home, ".pi", "agent", "pip");
    const usageDir = join(dir, "usage");
    mkdirSync(join(usageDir, "daily"), { recursive: true });
    const claimedSource = "token-usage.json.migrating.123.456";
    writeFileSync(join(dir, claimedSource), JSON.stringify(legacyRollup(), null, 2) + "\n", "utf8");
    writeFileSync(
      dailyPath(home, "2026-06-01"),
      JSON.stringify({ ...legacyRollup(), migratedLegacySources: [claimedSource] }, null, 2) + "\n",
      "utf8"
    );

    const { migrateUsageStorage, readRollups } = await loadStorage();
    migrateUsageStorage();

    const saved = readRollups();
    expect(saved.buckets["2026-06-01|anthropic|claude-sonnet"]).toMatchObject({ turns: 2, total: 25 });
    expect(existsSync(join(dir, claimedSource))).toBe(false);
  });

  it("migrates the previous usage rollup file into a daily summary and removes it", async () => {
    const dir = join(home, ".pi", "agent", "pip", "usage");
    mkdirSync(dir, { recursive: true });
    writeFileSync(legacyUsageRollupPath(home), JSON.stringify(legacyRollup(), null, 2) + "\n", "utf8");

    const { migrateUsageStorage } = await loadStorage();
    migrateUsageStorage();

    const saved = JSON.parse(readFileSync(dailyPath(home, "2026-06-01"), "utf8"));
    expect(saved.buckets["2026-06-01|anthropic|claude-sonnet"]).toMatchObject({ turns: 2, total: 25 });
    expect(existsSync(legacyUsageRollupPath(home))).toBe(false);
  });
});
