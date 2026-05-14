import { describe, expect, it } from "vitest";
import quietTools from "./index.ts";
import { createMockPi, getRegisteredTool } from "pip-common/testing";

const theme = { fg: (_name: string, text: string) => text };

describe("pi-quiet-tools", () => {
  it("registers built-in quiet tool overrides", () => {
    const pi = createMockPi();
    quietTools(pi as any);
    expect([...pi.tools.keys()]).toEqual(["read", "grep", "find", "ls"]);
  });

  it("renders compact read calls", () => {
    const pi = createMockPi();
    quietTools(pi as any);
    const read = getRegisteredTool(pi, "read");
    const rendered = read.renderCall({ path: "/tmp/file.ts", offset: 3, limit: 2 }, theme, { expanded: false }).render(80).join("\n");
    expect(rendered).toContain("› read: /tmp/file.ts:3-4");
    expect(rendered).not.toContain("expanded");
  });

  it("warns when quiet tool output is globally expanded", () => {
    const pi = createMockPi();
    quietTools(pi as any);
    const read = getRegisteredTool(pi, "read");
    const rendered = read.renderCall({ path: "/tmp/file.ts" }, theme, { expanded: true }).render(80).join("\n");
    expect(rendered).toContain("› read: /tmp/file.ts");
    expect(rendered).toContain("expanded");
  });

  it("hides successful collapsed results but shows errors", () => {
    const pi = createMockPi();
    quietTools(pi as any);
    const grep = getRegisteredTool(pi, "grep");
    expect(grep.renderResult({ content: [{ type: "text", text: "ok" }] }, { expanded: false }, theme).render(80)).toEqual([]);
    expect(grep.renderResult({ content: [{ type: "text", text: "Error: nope\nmore" }] }, { expanded: false }, theme).render(80).join("\n")).toContain("Error: nope");
  });
});
