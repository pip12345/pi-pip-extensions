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
      { provider: "Codex", fetchedAt: Date.now(), windows: [{ label: "5h", usedPercent: 40, resetsIn: "2h" }] },
      120,
      theme
    );
    expect(lines.join("\n")).toContain("Codex");
    expect(lines.join("\n")).toContain("5h");
  });

  it("renders a tools-expanded warning", () => {
    expect(__test.renderToolsExpandedWarning({ ui: { getToolsExpanded: () => true } }, theme)).toBe("tools expanded");
    expect(__test.renderToolsExpandedWarning({ ui: { getToolsExpanded: () => false } }, theme)).toBe("");
  });

  it("parses git status", () => {
    const git = __test.parseGitStatus("# branch.head main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b file.ts");
    expect(git).toEqual({ branch: "main", dirty: true, ahead: 2, behind: 1 });
  });
});
