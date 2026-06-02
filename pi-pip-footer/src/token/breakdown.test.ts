import { describe, expect, it } from "vitest";
import { getBranchTokens, interpolateTokenBreakdown } from "./breakdown.ts";
import { createMockCtx } from "../../../pip-common/testing.ts";

describe("pi-pip-footer token breakdown", () => {
  it("counts assistant usage even when the assistant stop reason is error/aborted", () => {
    const entries = [
      { id: "u1", messages: [{ role: "user", content: "hi" }] },
      { id: "a1", parentId: "u1", messages: [{ role: "assistant", stopReason: "error", usage: { input: 1000, output: 2000, cacheRead: 3000, cost: { total: 0.04 } } }] },
      { id: "a2", parentId: "a1", messages: [{ role: "assistant", stopReason: "aborted", usage: { input: 4000, output: 5000, cacheWrite: 6000, cost: { total: 0.05 } } }] },
    ];
    const ctx = createMockCtx({ entries, model: { contextWindow: 272_000 } });
    expect(getBranchTokens(ctx)).toMatchObject({ input: 5000, output: 7000, cache: 9000, cost: 0.09 });
  });

  it("interpolates token values for count-up animation", () => {
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
