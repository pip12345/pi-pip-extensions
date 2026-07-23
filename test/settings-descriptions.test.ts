import { describe, expect, it } from "vitest";
import { getPipSettingsRegistry } from "../pip-common/index.ts";
import pipFooter from "../pi-pip-footer/index.ts";
import toolUi from "../pi-tool-ui/index.ts";
import promptProfiles from "../pi-prompt-profiles/index.ts";
import secretsGuard from "../pi-secrets-guard/index.ts";
import todo from "../pi-todo/index.ts";
import subagents from "../pi-subagents/index.ts";
import treeEdit from "../pi-tree-edit/index.ts";
import undoRedo from "../pi-undo-redo/index.ts";
import web from "../pi-webfetch-websearch/index.ts";
import tinyMcp from "../pi-tiny-mcp/index.ts";
import { createMockPi } from "../pip-common/testing.ts";

const extensions = [pipFooter, toolUi, promptProfiles, secretsGuard, todo, subagents, treeEdit, undoRedo, web, tinyMcp];

describe("pip settings descriptions", () => {
  it("all registered pip settings have concise descriptions", () => {
    const owner = createMockPi();
    for (const extension of extensions) {
      const pi = createMockPi();
      pi.events = owner.events;
      extension(pi as any);
    }

    const missing: string[] = [];
    for (const row of getPipSettingsRegistry(owner).rows()) {
      if (!row.definition.description?.trim()) missing.push(row.path);
    }

    expect(missing).toEqual([]);
    expect(getPipSettingsRegistry(owner).rows()).toHaveLength(34);
  });
});
