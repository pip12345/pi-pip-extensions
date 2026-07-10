import { describe, expect, it } from "vitest";
import { pipSettings } from "../pip-common/index.ts";
import pipFooter from "../pi-pip-footer/index.ts";
import providerModelPatches from "../pi-provider-model-patches/index.ts";
import toolUi from "../pi-tool-ui/index.ts";
import promptProfiles from "../pi-prompt-profiles/index.ts";
import secretsGuard from "../pi-secrets-guard/index.ts";
import planMode from "../pi-plan-mode/index.ts";
import todo from "../pi-todo/index.ts";
import subagents from "../pi-subagents/index.ts";
import treeEdit from "../pi-tree-edit/index.ts";
import undoRedo from "../pi-undo-redo/index.ts";
import { createMockPi } from "../pip-common/testing.ts";

const extensions = [pipFooter, providerModelPatches, toolUi, promptProfiles, secretsGuard, planMode, todo, subagents, treeEdit, undoRedo];

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
