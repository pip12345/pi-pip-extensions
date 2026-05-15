import { describe, expect, it } from "vitest";
import { pipSettings } from "pip-common";
import pipFooter from "../pi-pip-footer/index.ts";
import quietTools from "../pi-quiet-tools/index.ts";
import promptProfiles from "../pi-prompt-profiles/index.ts";
import todo from "../pi-todo/index.ts";
import treeEdit from "../pi-tree-edit/index.ts";
import undoRedo from "../pi-undo-redo/index.ts";
import { createMockPi } from "pip-common/testing";

const extensions = [pipFooter, quietTools, promptProfiles, todo, treeEdit, undoRedo];

describe("pip settings descriptions", () => {
  it("all registered pip settings have concise descriptions", () => {
    for (const extension of extensions) extension(createMockPi() as any);

    const missing: string[] = [];
    for (const row of pipSettings.rows()) {
      if (!row.definition.description?.trim()) missing.push(row.path);
    }

    expect(missing).toEqual([]);
  });
});
