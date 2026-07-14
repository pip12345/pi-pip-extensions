import { describe, expect, it } from "vitest";
import { createMockCtx } from "pip-common/testing";
import { getContextInfo, renderContextLine } from "./context.ts";

const theme = { fg: (_name: string, text: string) => text };

describe("pi-pip-footer context rendering", () => {
  it("treats nullable direct context usage as unknown after compaction", () => {
    const entries = [
      { id: "u1", messages: [{ role: "user", content: "hi" }] },
      { id: "a1", parentId: "u1", messages: [{ role: "assistant", usage: { input: 90_000_000, output: 1_000, total: 90_001_000 } }] },
    ];
    const ctx = createMockCtx({ entries, model: { contextWindow: 272_000 }, contextUsage: { tokens: null, percent: null, contextWindow: 272_000 } });

    expect(getContextInfo(ctx)).toEqual({ percentage: null, used: null, total: 272_000 });
    expect(renderContextLine(ctx, 80, theme)).toContain("?/272k");
  });

  it("honors direct zero context usage instead of falling back to branch token totals", () => {
    const entries = [{ id: "a1", messages: [{ role: "assistant", usage: { input: 90_000_000, total: 90_000_000 } }] }];
    const ctx = createMockCtx({ entries, model: { contextWindow: 272_000 }, contextUsage: { tokens: 0, percent: 0, contextWindow: 272_000 } });

    expect(getContextInfo(ctx)).toEqual({ percentage: 0, used: 0, total: 272_000 });
  });
});
