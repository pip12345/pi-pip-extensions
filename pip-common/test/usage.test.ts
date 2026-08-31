import { describe, expect, it } from "vitest";
import { addUsage, cacheHitRateFromUsage, emptyUsage, formatCompactUsage, formatTokenCount, freshInputTokensFromUsage, normalizeUsage, promptTokensFromUsage, sessionUsageRecords, sumSessionUsage } from "../src/usage.ts";

describe("usage helpers", () => {
  it("normalizes common provider usage shapes", () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 }, cost: { total: 0.01 } })).toEqual({
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 0,
      cache: 3,
      total: 18,
      cost: 0.01,
    });
  });

  it("prefers native total when present", () => {
    expect(normalizeUsage({ input: 10, output: 5, totalTokens: 99 })?.total).toBe(99);
  });

  it("adds usage in place", () => {
    const total = emptyUsage();
    addUsage(total, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cache: 7, total: 10, cost: 0.2 });
    expect(total.total).toBe(10);
    expect(total.cache).toBe(7);
  });

  it("collects canonical billed usage from persisted session entries", () => {
    const entries = [
      { type: "message", id: "a1", timestamp: "2026-07-21T10:00:00.000Z", message: { role: "assistant", provider: "openrouter", model: "router", responseModel: "actual", usage: { input: 10, output: 2, cost: { total: 0.01 } } } },
      { type: "message", id: "t1", message: { role: "toolResult", toolName: "paid-tool", usage: { input: 3, output: 1, cacheRead: 2, cost: { total: 0.02 } } } },
      { type: "compaction", id: "c1", tokensBefore: 90_000, usage: { input: 20, output: 4, cost: { total: 0.03 } } },
      { type: "branch_summary", id: "b1", usage: { input: 5, output: 1, cost: { total: 0.04 } } },
      { type: "compaction", id: "estimate-only", tokensBefore: 1_000_000 },
    ];

    expect(sessionUsageRecords(entries).map((record) => record.kind)).toEqual(["assistant", "tool", "compaction", "branch_summary"]);
    expect(sessionUsageRecords(entries)[0]).toMatchObject({ provider: "openrouter", model: "actual", timestamp: Date.parse("2026-07-21T10:00:00.000Z") });
    expect(sumSessionUsage(entries)).toMatchObject({ input: 38, output: 8, cacheRead: 2, total: 48, cost: 0.1 });
  });

  it("formats compact token counts", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_200)).toBe("1k");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });

  it("distinguishes fresh input from total prompt tokens", () => {
    const usage = { input: 2, output: 110, cacheRead: 0, cacheWrite: 166_066, cache: 166_066, total: 166_178, cost: 0 };
    expect(freshInputTokensFromUsage(usage)).toBe(166_068);
    expect(promptTokensFromUsage(usage)).toBe(166_068);
    expect(cacheHitRateFromUsage(usage)).toBe(0);
  });

  it("formats fresh input, output, and cache reads as separate buckets", () => {
    const usage = { input: 172_000, output: 6_000, cacheRead: 848_000, cacheWrite: 10_000, cache: 858_000, total: 1_036_000, cost: 0.42 };
    expect(formatCompactUsage(usage, { includeCost: true })).toBe("↓:182k ↑:6k ↻:848k · $0.42");
    expect(formatCompactUsage(usage, { includeCost: true, inputMode: "prompt" })).toBe("↓:1M ↑:6k ↻:848k · $0.42");
    expect(formatCompactUsage(usage, { includeCost: true, inputMode: "raw" })).toBe("↓:172k ↑:6k ↻:848k · $0.42");
  });
});
