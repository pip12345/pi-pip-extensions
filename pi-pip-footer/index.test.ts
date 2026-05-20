import { describe, expect, it } from "vitest";
import pipFooter, { __test } from "./index.ts";
import { createMockPi } from "pip-common/testing";

const theme = { fg: (_name: string, text: string) => text };

describe("pi-pip-footer", () => {
  it("registers footer/token lifecycle handlers", () => {
    const pi = createMockPi();
    pipFooter(pi as any);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("agent_start")).toBe(true);
    expect(pi.handlers.has("message_end")).toBe(true);
    expect(pi.handlers.has("model_select")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);
  });

  it("detects quota providers", () => {
    expect(__test.detectProvider("openai", "auto")).toBe("codex");
    expect(__test.detectProvider("anthropic", "auto")).toBe("anthropic");
    expect(__test.detectProvider("github-copilot", "auto")).toBe("copilot");
    expect(__test.detectProvider("whatever", "codex")).toBe("codex");
    expect(__test.detectProvider("openai", "off")).toBeNull();
  });

  it("renders quota usage lines", () => {
    const lines = __test.renderUsageLine(
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
    const lines = __test.renderUsageLine(
      { provider: "Codex", providerId: "codex", fetchedAt: Date.now(), windows: [], error: "HTTP 500" },
      120,
      theme
    );
    expect(lines.join("\n")).toContain("codex");
    expect(lines.join("\n")).toContain("usage offline");
  });

  it("renders token metrics with arrow/cache icons", () => {
    expect(__test.renderTokenMetric("↓", 273_000, false, theme)).toBe("↓:273k");
    expect(__test.renderTokenMetric("↑", 49_000, false, theme)).toBe("↑:49k");
    expect(__test.renderTokenMetric("↻", 14_300_000, false, theme)).toBe("↻:14.3M");
    expect(__test.renderTokenMetric("▣", 14_300_000, false, theme)).toBe("▣:14.3M");
    expect(__test.renderTokenMetric("◫", 14_300_000, false, theme)).toBe("◫:14.3M");
    expect(__test.renderTokenMetric("□", 14_300_000, false, theme)).toBe("□:14.3M");
  });

  it("interpolates token values for count-up animation", () => {
    const mid = __test.interpolateTokenBreakdown(
      { input: 55, output: 10, cacheRead: 0, cacheWrite: 0, cache: 100, total: 165 },
      { input: 59, output: 14, cacheRead: 0, cacheWrite: 0, cache: 200, total: 273 },
      0.5
    );
    expect(mid.input).toBe(57);
    expect(mid.output).toBe(12);
    expect(mid.cache).toBe(150);
  });

  it("renders a tools-expanded warning", () => {
    expect(__test.renderToolsExpandedWarning({ ui: { getToolsExpanded: () => true } }, theme)).toBe("tools expanded");
    expect(__test.renderToolsExpandedWarning({ ui: { getToolsExpanded: () => false } }, theme)).toBe("");
  });

  it("renders extension statuses for custom-footer mode", () => {
    const statuses = new Map([
      ["z", "later"],
      ["plan-mode", "plan"],
      ["bad", "hello\nworld"],
    ]);
    expect(__test.renderExtensionStatuses({ getExtensionStatuses: () => statuses })).toBe("hello world plan later");
    expect(__test.renderExtensionStatuses({ getExtensionStatuses: () => new Map() })).toBe("");
  });

  it("right-aligns add-ons without shifting left content and keeps edge padding", () => {
    const line = __test.joinRight("workspace > model > ctx", "tools expanded", 50);
    expect(line.startsWith("workspace > model > ctx")).toBe(true);
    expect(line.endsWith("tools expanded")).toBe(true);
    expect(line.length).toBe(49);
    expect(__test.joinRight("workspace > model > ctx", "tools expanded", 22)).toBe("workspace > model > ctx");
  });

  it("parses git status", () => {
    const git = __test.parseGitStatus("# branch.head main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b file.ts");
    expect(git).toEqual({ branch: "main", dirty: true, ahead: 2, behind: 1 });
  });
});
