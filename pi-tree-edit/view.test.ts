import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftSession } from "./draft.ts";
import { __test } from "./index.ts";
import { SUMMARY_CUSTOM_TYPE, type Entry } from "./types.ts";
import * as tree from "./tree.ts";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
const components: any[] = [];
afterEach(() => { for (const component of components.splice(0)) component.dispose(); vi.restoreAllMocks(); });
function entries(count: number): Entry[] {
  return Array.from({ length: count }, (_, i) => ({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp: new Date(i * 1000).toISOString(), message: { role: "user", content: `message ${i}`, timestamp: i * 1000 } }));
}
function view(items: Entry[], leaf = items.at(-1)?.id ?? null, rows = 32, selected = leaf) {
  const draft = new DraftSession({ type: "session" }, items, leaf);
  draft.viewSelectedId = selected;
  const terminal = { rows };
  const done = vi.fn();
  const component: any = new __test.TreeEditComponent(draft, { model: { contextWindow: 1_050_000 } }, { terminal, requestRender: vi.fn() }, theme, done);
  components.push(component);
  return { component, draft, terminal, done };
}
function selectedId(component: any) { return component.visibleRows()[component.selected]?.entry.id; }

describe("tree-edit initial position", () => {
  it("selects and centers the current location in the middle of a large tree", () => {
    const { component, draft } = view(entries(200), "e100");
    component.render(120);
    expect(selectedId(component)).toBe("e100");
    expect(component.selected - component.scroll).toBe(Math.floor(component.pageSize() / 2));
    expect(draft.targetLeafId).toBe("e100");
    expect(draft.dirty).toBe(false);
  });

  it("resolves a hidden current leaf to its nearest visible ancestor", () => {
    const items = entries(100);
    items.push({ type: "custom", id: "hidden", parentId: "e99", timestamp: new Date().toISOString(), customType: "state", data: {} });
    const { component, draft } = view(items);
    component.render(120);
    expect(selectedId(component)).toBe("e99");
    expect(component.scroll).toBeGreaterThan(0);
    expect(draft.targetLeafId).toBe("hidden");
    expect(draft.dirty).toBe(false);
  });

  it("resolves a hidden tool result and empty assistant at the current location", () => {
    const items = entries(30);
    items.push({ type: "message", id: "assistant", parentId: "e29", timestamp: new Date().toISOString(), message: { role: "assistant", content: [], stopReason: "toolUse" } });
    items.push({ type: "message", id: "tool", parentId: "assistant", timestamp: new Date().toISOString(), message: { role: "toolResult", content: [], toolName: "read" } });
    expect(selectedId(view(items).component)).toBe("e29");
  });

  it("preserves an explicit selection on reopening and does not recenter ordinary movement", () => {
    const { component } = view(entries(200), "e180", 40, "e60");
    component.render(120);
    expect(selectedId(component)).toBe("e60");
    const scroll = component.scroll;
    component.handleInput("j");
    component.render(120);
    expect(selectedId(component)).toBe("e61");
    expect(component.scroll).toBe(scroll);
  });

  it("keeps the selection visible on resize and supports empty filters and multiple roots", () => {
    const items = [...entries(60), { ...entries(1)[0], id: "other", message: { role: "user", content: "other root" } }];
    const { component, terminal, draft } = view(items, "e40", 60);
    component.render(90);
    terminal.rows = 18;
    component.render(60);
    expect(component.selected).toBeGreaterThanOrEqual(component.scroll);
    expect(component.selected).toBeLessThan(component.scroll + component.pageSize());
    component.handleInput("f");
    component.handleInput("f");
    component.handleInput("f");
    expect(component.render(60).join("\n")).toContain("No entries");
    expect(draft.dirty).toBe(false);
    expect(view([], null).component.render(90).join("\n")).toContain("No entries");
  });
});

describe("tree-edit rendering work", () => {
  it("reuses tree rows and context estimates during movement and unchanged redraws", () => {
    const rows = vi.spyOn(tree, "visibleRows");
    const percentages = vi.spyOn(tree, "contextPercentByEntry");
    const { component } = view(entries(2000), "e1000");
    component.render(120);
    const rowCalls = rows.mock.calls.length;
    const contextCalls = percentages.mock.calls.length;
    for (let i = 0; i < 10; i++) { component.handleInput("j"); component.render(120); }
    component.invalidate();
    component.render(100);
    expect(rows).toHaveBeenCalledTimes(rowCalls);
    expect(percentages).toHaveBeenCalledTimes(contextCalls);
  });

  it("refreshes rows after filtering, search, deletion, and undo/redo", () => {
    const { component } = view(entries(30), "e15");
    const initial = component.visibleRows();
    component.handleInput("f");
    expect(component.visibleRows()).not.toBe(initial);
    component.handleInput("/");
    for (const key of "message 15") component.handleInput(key === " " ? "space" : key);
    component.handleInput("return");
    expect(component.visibleRows()).toHaveLength(1);
    component.handleInput("d");
    expect(component.visibleRows()).toHaveLength(0);
    component.handleInput("u");
    expect(component.visibleRows()).toHaveLength(1);
    component.handleInput("U");
    expect(component.visibleRows()).toHaveLength(0);
  });

  it("refreshes cached tool context after pruning and supports paste undo", () => {
    const items = entries(3);
    items.push({ type: "message", id: "tool", parentId: "e2", timestamp: new Date().toISOString(), message: { role: "toolResult", toolName: "read", toolCallId: "call", content: [{ type: "text", text: "large output ".repeat(1000) }] } });
    const { component, draft } = view(items, "e2");
    component.handleInput("f");
    component.handleInput("j");
    component.render(120);
    const percentages = component.contextPercents();
    component.handleInput("t");
    component.render(120);
    expect(component.contextPercents()).not.toBe(percentages);
    expect(draft.entries.at(-1)?.message.content[0].text).toContain("pruned");
    component.handleInput("u");
    expect(draft.entries.at(-1)?.message.content[0].text).toContain("large output");
    component.handleInput("k");
    component.handleInput("y");
    component.handleInput("P");
    expect(component.visibleRows()).toHaveLength(5);
    component.handleInput("u");
    expect(component.visibleRows()).toHaveLength(4);
  });

  it("bounds deep-branch indentation and keeps message text visible", () => {
    const { component } = view(entries(2));
    const row = { entry: entries(1)[0], depth: 10000, isLast: true, gutters: Array.from({ length: 10000 }, (_, position) => ({ position, show: true })), showConnector: true, isVirtualRootChild: false, foldable: false, folded: false, multipleRoots: false, activePath: true };
    const prefix = component.treePrefix(row, 30);
    expect(prefix.length).toBeLessThanOrEqual(30);
    expect(prefix).toContain("…");
    component.rowsCache = [row];
    component.selected = 0;
    expect(component.render(90).join("\n")).toContain("message 0");
  });

  it("keeps saved summaries readable without offering new summary generation", () => {
    const items = entries(2);
    items.push({ type: "custom_message", id: "summary", parentId: "e1", timestamp: new Date().toISOString(), customType: SUMMARY_CUSTOM_TYPE, content: "Saved summary", details: { kind: "summary", sourceEntryIds: ["e0"] } });
    const { component, draft, done } = view(items);
    component.handleInput("S");
    expect(done).not.toHaveBeenCalled();
    expect(draft.clipboard).toBeNull();
    expect(component.render(120).join("\n")).not.toContain("S summarize");
    component.handleInput("o");
    expect(component.visibleRows().some((row: any) => row.virtual?.sourceEntryId === "e0")).toBe(true);
    component.handleInput("j");
    expect(component.visibleRows()[component.selected].virtual?.sourceEntryId).toBe("e0");
    component.handleInput("f");
    expect(component.visibleRows()[component.selected].virtual?.sourceEntryId).toBe("e0");
  });
});
