import { describe, expect, it, vi } from "vitest";
import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { DraftSession } from "./draft.ts";
import type { Entry } from "./types.ts";

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function entry(id: string, parentId: string | null, fields: Record<string, unknown>): Entry {
  return { id, parentId, timestamp: "2026-01-01T00:00:00.000Z", ...fields } as Entry;
}
function user(id: string, parentId: string | null, content = id): Entry {
  return entry(id, parentId, { type: "message", message: { role: "user", content, timestamp: 0 } });
}
function context(instructions: string | undefined = "") {
  const complete = vi.fn(async () => ({ role: "assistant", content: [{ type: "text", text: "generated checkpoint" }], stopReason: "stop", usage }));
  const editor = vi.fn(async (title: string): Promise<string | undefined> => title.startsWith("Compaction instructions") ? instructions : "reviewed checkpoint");
  return { model: { provider: "test", id: "test", maxTokens: 8192, contextWindow: 200000 }, modelRegistry: { complete }, ui: { notify: vi.fn(), editor } };
}
function requestText(ctx: ReturnType<typeof context>): string {
  return JSON.stringify((ctx.modelRegistry.complete.mock.calls as any)[0]?.[1]);
}

describe("tree-edit compaction", () => {
  it("uses the latest branch-local replacements and omissions without changing raw history", async () => {
    const entries = [
      user("u", null, "original request"),
      user("omit", "u", "omit this content"),
      entry("r1", "omit", { type: "context_edit", targetId: "u", replacement: { content: "earlier replacement" } }),
      entry("r2", "r1", { type: "context_edit", targetId: "u", replacement: { content: "latest replacement" } }),
      entry("o", "r2", { type: "context_edit", targetId: "omit", replacement: null }),
      user("selected", "o", "keep this message"),
      entry("sibling", "u", { type: "context_edit", targetId: "u", replacement: { content: "sibling replacement" } }),
    ];
    const original = JSON.stringify(entries);
    const draft = new DraftSession({ type: "session" }, entries, "selected");
    const ctx = context();
    const id = await draft.compactBefore("selected", ctx);
    expect(id).toBeTypeOf("string");
    const text = requestText(ctx);
    expect(text).toContain("latest replacement");
    for (const absent of ["original request", "earlier replacement", "omit this content", "sibling replacement", "keep this message"]) expect(text).not.toContain(absent);
    expect(JSON.stringify(draft.entries.slice(0, entries.length - 1))).toBe(original);
    expect(draft.entries.find((e) => e.id === id)?.usage).toEqual(usage);
  });

  it("honors edits recorded after the retained boundary on the active continuation", async () => {
    const items = [
      user("u", null, "original prefix"),
      user("omitted", "u", "late omission"),
      user("selected", "omitted"),
      entry("replace", "selected", { type: "context_edit", targetId: "u", replacement: { content: "later replacement" } }),
      entry("omit", "replace", { type: "context_edit", targetId: "omitted", replacement: null }),
    ];
    const draft = new DraftSession({ type: "session" }, items, "omit");
    const ctx = context();
    await draft.compactBefore("selected", ctx);
    expect(requestText(ctx)).toContain("later replacement");
    expect(requestText(ctx)).not.toContain("original prefix");
    expect(requestText(ctx)).not.toContain("late omission");
  });

  it("includes projected custom messages", async () => {
    const entries = [entry("custom", null, { type: "custom_message", customType: "context", content: "important custom context", display: true }), user("selected", "custom")];
    const draft = new DraftSession({ type: "session" }, entries, "selected");
    const ctx = context();
    await draft.compactBefore("selected", ctx);
    expect(requestText(ctx)).toContain("important custom context");
  });

  it("retains tool output in compaction input", async () => {
    const items = [
      user("u", null),
      entry("a", "u", { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "file.txt" } }], stopReason: "toolUse" } }),
      entry("tool", "a", { type: "message", message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "critical tool output" }] } }),
      user("selected", "tool"),
    ];
    const draft = new DraftSession({ type: "session" }, items, "selected");
    const ctx = context();
    await draft.compactBefore("selected", ctx);
    expect(requestText(ctx)).toContain("critical tool output");
  });

  it("makes a checkpoint at the current leaf active immediately", async () => {
    const draft = new DraftSession({ type: "session" }, [user("u", null), user("selected", "u")], "selected");
    const id = await draft.compactBefore("selected", context());
    expect(draft.targetLeafId).toBe(id);
    const messages = buildSessionContext(draft.entries as SessionEntry[], draft.targetLeafId).messages;
    expect(JSON.stringify(messages)).toContain("reviewed checkpoint");
    expect(JSON.stringify(messages)).not.toContain('"content":"u"');
  });

  it("preserves the previous checkpoint and still-retained messages on repeated compaction", async () => {
    const entries = [
      user("old", null, "already summarized raw history"),
      user("kept", "old", "previously retained message"),
      entry("checkpoint", "kept", { type: "compaction", summary: "previous checkpoint context", firstKeptEntryId: "kept", tokensBefore: 100 }),
      user("new", "checkpoint", "new work"),
      user("selected", "new"),
    ];
    const draft = new DraftSession({ type: "session" }, entries, "selected");
    const ctx = context();
    await draft.compactBefore("selected", ctx);
    expect(requestText(ctx)).toContain("previous checkpoint context");
    expect(requestText(ctx)).toContain("previously retained message");
    expect(requestText(ctx)).toContain("new work");
    expect(requestText(ctx)).not.toContain("already summarized raw history");
  });

  it("does not revive superseded checkpoints retained only as raw history", async () => {
    const items = [
      user("kept", null),
      entry("old", "kept", { type: "compaction", summary: "superseded checkpoint", firstKeptEntryId: "kept", tokensBefore: 100 }),
      user("middle", "old"),
      entry("new", "middle", { type: "compaction", summary: "current checkpoint", firstKeptEntryId: "kept", tokensBefore: 200 }),
      user("selected", "new"),
    ];
    const draft = new DraftSession({ type: "session" }, items, "selected");
    const ctx = context();
    await draft.compactBefore("selected", ctx);
    expect(requestText(ctx)).toContain("current checkpoint");
    expect(requestText(ctx)).not.toContain("superseded checkpoint");
  });

  it("collects multiline handoff instructions before generation and retains summary review", async () => {
    const draft = new DraftSession({ type: "session" }, [user("u", null), user("selected", "u")], "selected");
    const ctx = context("Focus on the handoff.\nPreserve deployment blockers.");
    await draft.compactBefore("selected", ctx);
    expect(ctx.ui.editor.mock.calls.map(([title]) => title)).toEqual(["Compaction instructions (optional, empty uses defaults)", "Review compaction summary"]);
    expect(requestText(ctx)).toContain("Focus on the handoff.");
    expect(requestText(ctx)).toContain("Preserve deployment blockers.");
    expect(requestText(ctx)).toContain("selected message and later entries will remain");
  });

  it("cancels instruction entry without a request or a draft checkpoint", async () => {
    const draft = new DraftSession({ type: "session" }, [user("u", null), user("selected", "u")], "selected");
    const before = JSON.stringify(draft.entries);
    const ctx = context(undefined);
    // An explicit undefined models Escape, not an empty submitted editor.
    ctx.ui.editor.mockResolvedValueOnce(undefined);
    const checkpoint = vi.spyOn(draft, "checkpoint");
    expect(await draft.compactBefore("selected", ctx)).toBeNull();
    expect(ctx.modelRegistry.complete).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
    expect(JSON.stringify(draft.entries)).toBe(before);
    expect(draft.targetLeafId).toBe("selected");
    expect(draft.dirty).toBe(false);
  });

  it("does not prompt or request a summary when all contributions are omitted", async () => {
    const entries = [user("u", null), entry("omit", "u", { type: "context_edit", targetId: "u", replacement: null }), user("selected", "omit")];
    const draft = new DraftSession({ type: "session" }, entries, "selected");
    const ctx = context();
    expect(await draft.compactBefore("selected", ctx)).toBeNull();
    expect(ctx.ui.editor).not.toHaveBeenCalled();
    expect(ctx.modelRegistry.complete).not.toHaveBeenCalled();
  });

  it("allows empty instructions and undoing a successful compaction", async () => {
    const draft = new DraftSession({ type: "session" }, [user("u", null), user("selected", "u")], "selected");
    const before = JSON.stringify(draft.entries);
    const ctx = context("");
    expect(await draft.compactBefore("selected", ctx)).toBeTypeOf("string");
    expect(ctx.modelRegistry.complete).toHaveBeenCalledOnce();
    draft.undo();
    expect(JSON.stringify(draft.entries)).toBe(before);
    expect(draft.targetLeafId).toBe("selected");
    expect(draft.dirty).toBe(false);
  });

  it("does not checkpoint a cancelled summary review", async () => {
    const draft = new DraftSession({ type: "session" }, [user("u", null), user("selected", "u")], "selected");
    const ctx = context();
    ctx.ui.editor.mockResolvedValueOnce("").mockResolvedValueOnce(undefined);
    const checkpoint = vi.spyOn(draft, "checkpoint");
    expect(await draft.compactBefore("selected", ctx)).toBeNull();
    expect(checkpoint).not.toHaveBeenCalled();
    expect(draft.entries).toHaveLength(2);
  });
});
