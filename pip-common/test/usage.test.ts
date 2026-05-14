import { describe, expect, it } from "vitest";
import { addUsage, emptyUsage, formatTokenCount, normalizeUsage } from "../src/usage.ts";

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
});
