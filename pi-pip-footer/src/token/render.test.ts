import { describe, expect, it } from "vitest";
import { renderTokenMetric } from "./render.ts";

const theme = { fg: (_name: string, text: string) => text };

describe("pi-pip-footer token rendering", () => {
  it("renders token metrics with arrow/cache icons", () => {
    expect(renderTokenMetric("↓", 273_000, false, theme)).toBe("↓:273k");
    expect(renderTokenMetric("↑", 49_000, false, theme)).toBe("↑:49k");
    expect(renderTokenMetric("↻", 14_300_000, false, theme)).toBe("↻:14.3M");
    expect(renderTokenMetric("▣", 14_300_000, false, theme)).toBe("▣:14.3M");
    expect(renderTokenMetric("◫", 14_300_000, false, theme)).toBe("◫:14.3M");
    expect(renderTokenMetric("□", 14_300_000, false, theme)).toBe("□:14.3M");
  });
});
