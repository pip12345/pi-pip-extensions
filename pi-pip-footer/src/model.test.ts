import { describe, expect, it } from "vitest";
import { renderExtensionStatuses, renderToolsExpandedWarning } from "./model.ts";

const theme = { fg: (_name: string, text: string) => text };

describe("pi-pip-footer model/footer adornments", () => {
  it("renders a tools-expanded warning", () => {
    expect(renderToolsExpandedWarning({ ui: { getToolsExpanded: () => true } }, theme)).toBe("tools expanded");
    expect(renderToolsExpandedWarning({ ui: { getToolsExpanded: () => false } }, theme)).toBe("");
  });

  it("renders extension statuses for custom-footer mode", () => {
    const statuses = new Map([
      ["z", "later"],
      ["plan-mode", "plan"],
      ["bad", "hello\nworld"],
    ]);
    expect(renderExtensionStatuses({ getExtensionStatuses: () => statuses })).toBe("hello world plan later");
    expect(renderExtensionStatuses({ getExtensionStatuses: () => new Map() })).toBe("");
  });
});
