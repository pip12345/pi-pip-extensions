import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadStorage() {
  vi.resetModules();
  return await import("./storage.ts");
}

function usagePath(home: string) {
  return join(home, ".pi", "agent", "pip", "usage", "token-usage.json");
}

describe("pi-stats usage storage", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pi-stats-storage-"));
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("writes global usage rollups under the usage subdirectory", async () => {
    const { updateRollups } = await loadStorage();

    updateRollups({
      ts: Date.UTC(2026, 5, 1, 12),
      provider: "anthropic",
      model: "claude-sonnet",
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 3,
      cache: 5,
      total: 20,
      cost: 0.01,
    });

    expect(existsSync(usagePath(home))).toBe(true);
    const saved = JSON.parse(readFileSync(usagePath(home), "utf8"));
    expect(saved.version).toBe(1);
    expect(saved.buckets["2026-06-01|anthropic|claude-sonnet"]).toMatchObject({
      day: "2026-06-01",
      provider: "anthropic",
      model: "claude-sonnet",
      turns: 1,
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 3,
      cache: 5,
      total: 20,
      cost: 0.01,
    });
  });
});
