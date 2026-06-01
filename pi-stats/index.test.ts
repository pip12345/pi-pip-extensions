import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCtx, createMockPi, emitEvent } from "../pip-common/testing.ts";

async function loadStats() {
  vi.resetModules();
  return (await import("./index.ts")).default;
}

function usagePath(home: string) {
  return join(home, ".pi", "agent", "pip", "token-usage.json");
}

function legacyUsagePath(home: string) {
  return join(home, ".pi", "agent", "pip", "token-usage.jsonl");
}

describe("pi-stats", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pi-stats-"));
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("registers the stats command and usage event handlers", async () => {
    const stats = await loadStats();
    const pi = createMockPi();
    stats(pi as any);
    expect(pi.commands.has("stats")).toBe(true);
    expect(pi.handlers.has("message_end")).toBe(true);
  });

  it("writes global usage as daily provider/model rollups", async () => {
    const stats = await loadStats();
    const pi = createMockPi();
    stats(pi as any);

    await emitEvent(
      pi,
      "message_end",
      {
        message: {
          role: "assistant",
          timestamp: Date.UTC(2026, 5, 1, 12),
          provider: "anthropic",
          model: "claude-sonnet",
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, total: 20, cost: 0.01 },
        },
      },
      createMockCtx({ cwd: "/workspace" })
    );

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
    expect(existsSync(legacyUsagePath(home))).toBe(false);
  });

  it("migrates legacy JSONL usage into the rollup file and removes the old file", async () => {
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

    const stats = await loadStats();
    const pi = createMockPi();
    stats(pi as any);

    const saved = JSON.parse(readFileSync(usagePath(home), "utf8"));
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
    expect(existsSync(legacyUsagePath(home))).toBe(false);
  });
});
