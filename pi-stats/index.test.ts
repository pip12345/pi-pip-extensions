import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCtx, createMockPi, emitEvent } from "../pip-common/testing.ts";

async function loadStats() {
  vi.resetModules();
  return (await import("./index.ts")).default;
}

async function loadStatsModule() {
  vi.resetModules();
  return await import("./index.ts");
}

async function loadStorage() {
  return await import("./src/usage/storage.ts");
}

describe("pi-stats", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pi-stats-"));
    vi.stubEnv("HOME", home);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 1, 12)));
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("attributes subagent toolResult usage to the current session row", async () => {
    const { __test } = await loadStatsModule();
    const ctx = createMockCtx({
      entries: [
        { type: "message", id: "u1", message: { role: "user", content: "do work", timestamp: Date.UTC(2026, 5, 1, 12) } },
        { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", provider: "openai", model: "gpt", usage: { input: 10, output: 5, cacheRead: 2, cost: { total: 0.01 } } } },
        { type: "message", id: "tr1", parentId: "a1", message: { role: "toolResult", toolName: "subagent", details: { run: { usage: { input: 20, output: 6, cacheRead: 3, cost: 0.02 } } } } },
      ],
      model: { contextWindow: 1000 },
    });

    const rows = __test.buildSessionRows(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ input: 30, output: 11, cache: 5, cost: 0.03, subagentCount: 1 });
    expect(rows[0].parent).toMatchObject({ input: 10, output: 5, cache: 2, cost: 0.01 });
    expect(rows[0].subagents).toMatchObject({ input: 20, output: 6, cache: 3, cost: 0.02 });
    expect(__test.formatCacheWithHit(rows[0], true)).toBe("5/14%");
    expect(__test.formatCacheHit(rows[0].parent)).toBe("17%");
    expect(__test.formatCacheHit(rows[0].subagents)).toBe("13%");
  });

  it("formats cache hit rate from prompt-side cache reads", async () => {
    const { __test } = await loadStatsModule();
    expect(__test.cacheHitRate({ input: 1000, cacheRead: 3000, cacheWrite: 0 })).toBe(75);
    expect(__test.formatCacheWithHit({ input: 1000, output: 10, cacheRead: 3000, cacheWrite: 0, cache: 3000, total: 4010, cost: 0 }, true)).toBe("3k/75%");
    expect(__test.formatCacheWithHit({ input: 1000, output: 10, cacheRead: 3000, cacheWrite: 0, cache: 3000, total: 4010, cost: 0 }, true, { fg: (name: string, text: string) => `<${name}>${text}</${name}>` })).toBe("3k<dim>/75%</dim>");
    expect(__test.formatCacheWithHit({ input: 1000, output: 10, cacheRead: 3000, cacheWrite: 0, cache: 3000, total: 4010, cost: 0 }, true, undefined, 4)).toBe("  3k/75%");
    expect(__test.formatCacheWithHit({ input: 1000, output: 10, cacheRead: 3000, cacheWrite: 0, cache: 3000, total: 4010, cost: 0 }, true, undefined, 4, 5)).toBe("  3k/75% ");
    expect(__test.formatCacheWithHit({ input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, cache: 0, total: 1010, cost: 0 }, true)).toBe("0");
  });

  it("records assistant message usage through global usage storage", async () => {
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

    const { readRollups } = await loadStorage();
    const saved = readRollups();
    expect(saved.buckets["2026-06-01|anthropic|claude-sonnet"]).toMatchObject({
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
