import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("adds a compaction entry after the selected normal message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-edit-compaction-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "session-test" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
        JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 10, output: 5 } } }),
        JSON.stringify({ type: "message", id: "u2", parentId: "a1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "next" }] } }),
      ].join("\n") + "\n"
    );

    try {
      const pi = createMockPi();
      treeEdit(pi as any);
      const ctx: any = {
        waitForIdle: async () => undefined,
        switchSession: async (_file: string, opts: any) => opts.withSession({ navigateTree: async () => undefined, ui: { notify: () => undefined } }),
        sessionManager: {
          getSessionFile: () => sessionFile,
          getLeafId: () => "u2",
        },
        ui: {
          custom: async (factory: any) => {
            let result: any;
            const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
            const component = factory({ requestRender() {} }, theme, undefined, (value: any) => { result = value; }) as any;
            component.handleInput("k");
            component.handleInput("C");
            expect(component.render(120).join("\n")).toContain("C add compaction entry");
            component.handleInput("q");
            return result;
          },
          select: async () => "Save and quit",
          notify: () => undefined,
        },
      };

      await runCommand(pi, "tree-edit", "", ctx);
      const entries = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const compaction = entries.find((entry) => entry.type === "compaction");
      expect(compaction).toMatchObject({ parentId: "a1", summary: "", firstKeptEntryId: "u2", details: { from: "pi-tree-edit", kind: "manual", compactedThroughEntryId: "a1" } });
      expect(compaction.tokensBefore).toBeGreaterThan(0);
      expect(entries.find((entry) => entry.id === "u2")?.parentId).toBe(compaction.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not add compaction when selected entry is not a normal message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-edit-compaction-invalid-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "session-test" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
        JSON.stringify({ type: "message", id: "t1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "toolResult", toolName: "x", content: [{ type: "text", text: "tool" }] } }),
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
          getLeafId: () => "t1",
        },
        ui: {
          custom: async (factory: any) => {
            let result: any;
            const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
            const component = factory({ requestRender() {} }, theme, undefined, (value: any) => { result = value; }) as any;
            component.handleInput("f");
            component.handleInput("j");
            component.handleInput("C");
            expect(component.render(120).join("\n")).toContain("Select a user/assistant message to add compaction");
            component.handleInput("q");
            return result;
          },
          select: async () => {
            selectCalls++;
            return "Cancel";
          },
          notify: () => undefined,
        },
      };

      await runCommand(pi, "tree-edit", "", ctx);
      expect(selectCalls).toBe(0);
      const entries = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(entries.some((entry) => entry.type === "compaction")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
