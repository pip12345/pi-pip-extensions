import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import treeEdit from "./index.ts";
import { pipSettings } from "pip-common";
import { createMockPi, runCommand } from "pip-common/testing";

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

  it("quits immediately without prompting when the draft is clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-edit-clean-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "session-test" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
      ].join("\n") + "\n"
    );

    try {
      const pi = createMockPi();
      treeEdit(pi as any);
      let selectCalls = 0;
      const ctx: any = {
        waitForIdle: async () => undefined,
        sessionManager: {
          getSessionFile: () => sessionFile,
          getLeafId: () => "u1",
        },
        ui: {
          custom: async (_factory: any) => ({ action: "quit" }),
          select: async () => {
            selectCalls++;
            return "Cancel";
          },
          notify: () => undefined,
        },
      };

      await runCommand(pi, "tree-edit", "", ctx);
      expect(selectCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
