import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import undoRedo, { __test } from "./index.ts";
import { createMockCtx, createMockPi, emitEvent, runCommand } from "pip-common/testing";
import { parseSessionFile, serializeSessionFile, type SessionEntry } from "pip-common";

function user(id: string, parentId: string | null, text: string): SessionEntry {
  return { type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text }] } };
}
function assistant(id: string, parentId: string): SessionEntry {
  return { type: "message", id, parentId, message: { role: "assistant", content: [{ type: "text", text: id }] } };
}
function tempSession(entries: SessionEntry[]) {
  const dir = mkdtempSync(join(tmpdir(), "pi-undo-redo-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, serializeSessionFile({ header: { type: "session", leafId: entries.at(-1)?.id }, entries }));
  return path;
}
function ctxFor(path: string, entries: SessionEntry[]) {
  return createMockCtx({
    entries,
    leafId: entries.at(-1)?.id,
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
      getLeafId: () => entries.at(-1)?.id,
      getSessionFile: () => path,
    },
  });
}

describe("pi-undo-redo", () => {
  it("registers commands and input expiry hook", () => {
    const pi = createMockPi();
    undoRedo(pi as any);
    expect(pi.commands.has("undo")).toBe(true);
    expect(pi.commands.has("redo")).toBe(true);
    expect(pi.handlers.has("input")).toBe(true);
  });

  it("plans a tail-only undo", () => {
    const entries = [user("u1", null, "one"), assistant("a1", "u1"), user("u2", "a1", "two"), assistant("a2", "u2")];
    const plan = __test.planUndo(entries, entries, "a2");
    expect(plan.tail.map((entry) => entry.id)).toEqual(["u2", "a2"]);
    expect(plan.promptText).toBe("two");
  });

  it("restores skill invocations instead of expanded skill context", () => {
    const expanded = '<skill name="foo" location="/tmp/foo.md">\nReferences are relative to /tmp.\n\nHuge skill body\n</skill>\n\nhello';
    const entries = [user("u1", null, expanded), assistant("a1", "u1")];
    const plan = __test.planUndo(entries, entries, "a1");
    expect(plan.promptText).toBe("/skill:foo hello");
  });

  it("refuses undo when the target tail has an external child", () => {
    const branch = [user("u1", null, "one"), assistant("a1", "u1"), user("u2", "a1", "two"), assistant("a2", "u2")];
    const all = [...branch, user("u3", "a2", "three")];
    expect(() => __test.planUndo(branch, all, "a2")).toThrow(/not at the end/);
  });

  it("undo removes the tail, restores editor text, and redo restores exact entries", async () => {
    const entries = [user("u1", null, "one"), assistant("a1", "u1"), user("u2", "a1", "two"), assistant("a2", "u2")];
    const path = tempSession(entries);
    const pi = createMockPi();
    undoRedo(pi as any);
    const ctx = ctxFor(path, entries);

    await runCommand(pi, "undo", "", ctx);
    expect(parseSessionFile(path).entries.map((entry) => entry.id)).toEqual(["u1", "a1"]);
    expect((ctx.ui as any).editorText).toBe("two");
    expect((ctx.ui as any).notifications.at(-1).message).toContain("Undid");

    const redoCtx = ctxFor(path, parseSessionFile(path).entries);
    await runCommand(pi, "redo", "", redoCtx);
    expect(parseSessionFile(path).entries.map((entry) => entry.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("supports multiple undo and redo steps", async () => {
    const entries = [user("u1", null, "one"), assistant("a1", "u1"), user("u2", "a1", "two"), assistant("a2", "u2"), user("u3", "a2", "three"), assistant("a3", "u3")];
    const path = tempSession(entries);
    const pi = createMockPi();
    undoRedo(pi as any);

    await runCommand(pi, "undo", "", ctxFor(path, entries));
    expect(parseSessionFile(path).entries.map((entry) => entry.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(__test.redoStack()).toHaveLength(1);

    await runCommand(pi, "undo", "", ctxFor(path, parseSessionFile(path).entries));
    expect(parseSessionFile(path).entries.map((entry) => entry.id)).toEqual(["u1", "a1"]);
    expect(__test.redoStack()).toHaveLength(2);

    await runCommand(pi, "redo", "", ctxFor(path, parseSessionFile(path).entries));
    expect(parseSessionFile(path).entries.map((entry) => entry.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(__test.redoStack()).toHaveLength(1);

    await runCommand(pi, "redo", "", ctxFor(path, parseSessionFile(path).entries));
    expect(parseSessionFile(path).entries.map((entry) => entry.id)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3"]);
    expect(__test.redoStack()).toHaveLength(0);
  });

  it("preserves original file order when redo restores a non-file-tail branch", async () => {
    const entries = [user("u1", null, "one"), assistant("a1", "u1"), user("u2", "a1", "two"), assistant("a2", "u2"), user("sibling", "a1", "sibling")];
    const path = tempSession(entries);
    const pi = createMockPi();
    undoRedo(pi as any);
    const currentBranch = entries.slice(0, 4);
    const ctx = ctxFor(path, currentBranch);
    await runCommand(pi, "undo", "", ctx);
    await runCommand(pi, "redo", "", ctxFor(path, parseSessionFile(path).entries));
    expect(parseSessionFile(path).entries.map((entry) => entry.id)).toEqual(["u1", "a1", "u2", "a2", "sibling"]);
  });

  it("refuses undo when the session file header leaf disagrees with ctx", async () => {
    const entries = [user("u1", null, "one"), assistant("a1", "u1")];
    const path = tempSession(entries);
    writeFileSync(path, serializeSessionFile({ header: { type: "session", leafId: "other" }, entries }));
    const pi = createMockPi();
    undoRedo(pi as any);
    const ctx = ctxFor(path, entries);
    await runCommand(pi, "undo", "", ctx);
    expect((ctx.ui as any).notifications.at(-1).message).toContain("out of sync");
  });

  it("expires redo on normal input but not /redo", async () => {
    __test.setRedoSlot({ sessionFile: "x", promptText: "p", removedEntries: [], previousLeafId: null, restoredLeafId: "r", beforeUndoRecords: [{ type: "session" }], afterUndoHash: "h", createdAt: Date.now() });
    const pi = createMockPi();
    undoRedo(pi as any);
    await emitEvent(pi, "input", { text: "/redo" });
    expect(__test.redoSlot()).toBeTruthy();
    await emitEvent(pi, "input", { text: "new prompt" });
    expect(__test.redoSlot()).toBeUndefined();
  });
});
