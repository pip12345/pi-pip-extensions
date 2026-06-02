import { describe, expect, it } from "vitest";
import { renderUsageLine } from "./quota.ts";

const theme = { fg: (_name: string, text: string) => text };

describe("pi-pip-footer quota rendering", () => {
  it("renders quota usage lines", () => {
    const lines = renderUsageLine(
      {
        provider: "Codex",
        providerId: "codex",
        fetchedAt: Date.now(),
        windows: [
          { label: "5h", usedPercent: 40, resetsIn: "2h" },
          { label: "Week", usedPercent: 20, resetsIn: "6d" },
        ],
      },
      120,
      theme
    );
    expect(lines.join("\n")).toContain("codex");
    expect(lines.join("\n")).toContain("5h");
    expect(lines.join("\n")).toContain("7d");
    expect(lines.join("\n")).toContain("↻ 2h");
  });

  it("renders quota offline errors", () => {
    const lines = renderUsageLine({ provider: "Codex", providerId: "codex", fetchedAt: Date.now(), windows: [], error: "HTTP 500" }, 120, theme);
    expect(lines.join("\n")).toContain("codex");
    expect(lines.join("\n")).toContain("usage offline");
  });
});
