import { describe, expect, it } from "vitest";
import treeEdit from "./index.ts";
import { pipSettings } from "pip-common";
import { createMockPi } from "pip-common/testing";

describe("pi-tree-edit", () => {
  it("registers the tree-edit command", () => {
    const pi = createMockPi();
    treeEdit(pi as any);
    expect(pi.commands.has("tree-edit")).toBe(true);
  });

  it("registers tree-edit settings", () => {
    const pi = createMockPi();
    treeEdit(pi as any);
    expect(pipSettings.section("tree-edit")?.title).toBe("Tree Edit");
    expect(pipSettings.definition("tree-edit")?.summarySnapshots.default).toBe(true);
    expect(pipSettings.definition("tree-edit")?.snapshotToolResults.default).toBe("truncated");
    expect(pipSettings.definition("tree-edit")?.toolResultTruncation.default).toBe(20000);
  });
});
