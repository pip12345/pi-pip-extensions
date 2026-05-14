import { describe, expect, it } from "vitest";
import treeEdit from "./index.ts";
import { createMockPi } from "pip-common/testing";

describe("pi-tree-edit", () => {
  it("registers the tree-edit command", () => {
    const pi = createMockPi();
    treeEdit(pi as any);
    expect(pi.commands.has("tree-edit")).toBe(true);
  });
});
