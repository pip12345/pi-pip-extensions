import { describe, expect, it } from "vitest";
import { addUsage, cacheHitRateFromUsage, emptyUsage, formatCompactUsage, formatTokenCount, normalizeUsage, promptTokensFromUsage } from "../src/usage.ts";

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

  it("formats compact token counts", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_200)).toBe("1k");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });

  it("computes prompt-side input from uncached and cache buckets", () => {
    const usage = { input: 2, output: 110, cacheRead: 0, cacheWrite: 166_066, cache: 166_066, total: 166_178, cost: 0 };
    expect(promptTokensFromUsage(usage)).toBe(166_068);
    expect(cacheHitRateFromUsage(usage)).toBe(0);
  });

  it("formats compact usage with prompt-side input and cost", () => {
    expect(formatCompactUsage({ input: 172_000, output: 6_000, cacheRead: 848_000, cacheWrite: 0, cache: 848_000, total: 1_026_000, cost: 0.42 }, { includeCost: true })).toBe("↓:1M ↑:6k ↻:848k · $0.42");
  });

  it("can format compact usage with raw input separate from cache", () => {
    expect(formatCompactUsage({ input: 172_000, output: 6_000, cacheRead: 848_000, cacheWrite: 0, cache: 848_000, total: 1_026_000, cost: 0.42 }, { includeCost: true, inputMode: "raw" })).toBe("↓:172k ↑:6k ↻:848k · $0.42");
  });
});
