import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCtx } from "pip-common/testing";

async function loadBreakdown() {
  vi.resetModules();
  return await import("./breakdown.ts");
}

describe("pi-pip-footer token breakdown", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pip-footer-usage-"));
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("counts branch assistant usage for transcript-scoped callers", async () => {
    const { getBranchTokens } = await loadBreakdown();
    const entries = [
      { id: "u1", messages: [{ role: "user", content: "hi" }] },
      { id: "a1", parentId: "u1", messages: [{ role: "assistant", stopReason: "error", usage: { input: 1000, output: 2000, cacheRead: 3000, cost: { total: 0.04 } } }] },
      { id: "a2", parentId: "a1", messages: [{ role: "assistant", stopReason: "aborted", usage: { input: 4000, output: 5000, cacheWrite: 6000, cost: { total: 0.05 } } }] },
    ];
    const ctx = createMockCtx({ entries, model: { contextWindow: 272_000 } });
    const tokens = getBranchTokens(ctx);
    expect(tokens).toMatchObject({ input: 14_000, output: 7000, cache: 9000, cost: 0.09 });
    expect(tokens?.latestCacheHitRate).toBe(0);
  });

  it("counts historical parent and linked subagent usage from the usage ledger", async () => {
    const parentSession = "/tmp/parent.jsonl";
    const childSession = "/tmp/child.jsonl";
    const usageDir = join(home, ".pi", "agent", "pip", "usage", "events", "2026-06-02");
    mkdirSync(usageDir, { recursive: true });
    writeFileSync(
      join(usageDir, "events.jsonl"),
      [
        JSON.stringify({ id: "parent", ts: Date.UTC(2026, 5, 2, 13), sessionFile: parentSession, provider: "openai", model: "gpt", input: 10, output: 5, cacheRead: 2, cacheWrite: 0, cache: 2, total: 17, cost: 0.01 }),
        JSON.stringify({ id: "child", ts: Date.UTC(2026, 5, 2, 12), sessionFile: childSession, provider: "openai", model: "gpt", input: 20, output: 6, cacheRead: 3, cacheWrite: 0, cache: 3, total: 29, cost: 0.02 }),
      ].join("\n") + "\n",
      "utf8"
    );
    const parentsDir = join(home, ".pi", "agent", "pip", "subagents", "parents", "parent-record");
    mkdirSync(parentsDir, { recursive: true });
    writeFileSync(join(parentsDir, "runs.json"), JSON.stringify({ parentSessionFile: parentSession, runs: [{ sessionFile: childSession }] }), "utf8");
    const { getHistoricalSessionTokens } = await loadBreakdown();
    const ctx = createMockCtx({ sessionManager: { getSessionFile: () => parentSession } });
    const tokens = getHistoricalSessionTokens(ctx);
    expect(tokens).toMatchObject({ input: 35, output: 11, cache: 5, cost: 0.03 });
    expect(tokens?.latestCacheHitRate).toBeCloseTo((2 / 12) * 100);
  });

  it("computes cache hit rate from latest prompt cache reads", async () => {
    const { cacheHitRate, tokenBreakdownFromUsage } = await loadBreakdown();
    expect(cacheHitRate({ input: 1000, cacheRead: 3000, cacheWrite: 0 })).toBe(75);
    expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
    expect(tokenBreakdownFromUsage({ input: 1000, output: 10, cacheRead: 3000 })).toMatchObject({ input: 4000, latestCacheHitRate: 75 });
  });

  it("interpolates token values for count-up animation", async () => {
    const { interpolateTokenBreakdown } = await loadBreakdown();
    const mid = interpolateTokenBreakdown(
      { input: 55, output: 10, cacheRead: 0, cacheWrite: 0, cache: 100, total: 165, cost: 0.1 },
      { input: 59, output: 14, cacheRead: 0, cacheWrite: 0, cache: 200, total: 273, cost: 0.3 },
      0.5
    );
    expect(mid.input).toBe(57);
    expect(mid.output).toBe(12);
    expect(mid.cache).toBe(150);
    expect(mid.cost).toBeCloseTo(0.2);
  });
});
