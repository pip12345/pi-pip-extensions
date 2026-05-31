import { beforeEach, describe, expect, it } from "vitest";
import toolUi from "./index.ts";
import todo from "../pi-todo/index.ts";
import tinyMcp from "../pi-tiny-mcp/index.ts";
import { flushPipTools, pipSettings, resetPipToolsForTests } from "../pip-common/index.ts";
import { createMockPi, getRegisteredTool } from "../pip-common/testing.ts";

const theme = { fg: (_name: string, text: string) => text };

beforeEach(() => resetPipToolsForTests());

describe("pi-tool-ui", () => {
  it("registers built-in tool ui overrides", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    expect([...pi.tools.keys()]).toEqual(["read", "grep", "find", "ls", "edit"]);
    expect(pipSettings.definition("tool-ui")?.read.description).toContain("compact rendering");
    expect(pipSettings.definition("tool-ui")?.editDiff.description).toContain("split diffs");
  });

  it("renders compact read calls", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const read = getRegisteredTool(pi, "read");
    const rendered = read.renderCall({ path: "/tmp/file.ts", offset: 3, limit: 2 }, theme, { expanded: false }).render(80).join("\n");
    expect(rendered).toContain("› read: /tmp/file.ts:3-4");
    expect(rendered).not.toContain("expanded");
  });

  it("warns when tool output is globally expanded", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const read = getRegisteredTool(pi, "read");
    const rendered = read.renderCall({ path: "/tmp/file.ts" }, theme, { expanded: true }).render(80).join("\n");
    expect(rendered).toContain("› read: /tmp/file.ts");
    expect(rendered).toContain("expanded");
  });

  it("hides successful collapsed results but shows errors", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const grep = getRegisteredTool(pi, "grep");
    expect(grep.renderResult({ content: [{ type: "text", text: "ok" }] }, { expanded: false }, theme).render(80)).toEqual([]);
    expect(grep.renderResult({ content: [{ type: "text", text: "Error: nope\nmore" }] }, { expanded: false }, theme).render(80).join("\n")).toContain("Error: nope");
  });

  it("preserves edit call/shell slots while replacing result", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const edit = getRegisteredTool(pi, "edit");
    expect(edit.renderShell).toBe("self");
    expect(edit.renderCall).toBeTypeOf("function");
    expect(edit.renderResult).toBeTypeOf("function");
    expect(edit.prepareArguments).toBeTypeOf("function");
  });

  it("renders edit diffs as split view by default on wide terminals", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const edit = getRegisteredTool(pi, "edit");
    const diff = " 1 same\n-2 old value\n+2 new value\n 3 tail";
    const rendered = edit.renderResult({ content: [], details: { diff } }, { expanded: false }, theme, { state: {}, args: { path: "a.ts", edits: [] }, cwd: process.cwd(), isError: false }).render(140).join("\n");
    expect(rendered).toContain("old value");
    expect(rendered).toContain("new value");
    expect(rendered).toContain("│");
  });

  it("falls back to unified edit diffs on narrow terminals", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const edit = getRegisteredTool(pi, "edit");
    const diff = " 1 same\n-2 old value\n+2 new value\n 3 tail";
    const rendered = edit.renderResult({ content: [], details: { diff } }, { expanded: true }, theme, { state: {}, args: { path: "a.ts", edits: [] }, cwd: process.cwd(), isError: false }).render(80).join("\n");
    expect(rendered).toContain("-2 old value");
    expect(rendered).toContain("+2 new value");
    expect(rendered).not.toContain("│");
  });

  it("renders todo tools through display metadata when both plugins are loaded", () => {
    const pi = createMockPi();
    todo(pi as any);
    toolUi(pi as any);
    flushPipTools(pi as any);
    const write = getRegisteredTool(pi, "todo_write");

    expect(write.renderShell).toBe("self");
    expect(write.renderCall({ todos: [{ text: "x" }] }, theme, { expanded: false }).render(80).join("\n")).toContain("› todo_write: 1 todos");
    expect(write.renderResult({ content: [{ type: "text", text: "Set 1 todo" }], details: { todos: [{ id: 1, text: "x", status: "pending" }] } }, { expanded: false }, theme, {}).render(80)).toEqual([]);
    expect(pipSettings.definition("tool-ui")?.todo_write.description).toContain("compact Tool UI rendering");
  });

  it("display metadata rendering is load-order safe", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    todo(pi as any);
    flushPipTools(pi as any);
    const update = getRegisteredTool(pi, "todo_update");

    expect(update.renderShell).toBe("self");
    expect(update.renderCall({ updates: [{ match: "x", status: "done" }] }, theme, { expanded: false }).render(80).join("\n")).toContain("› todo_update: 1 updates");
    expect(pipSettings.definition("tool-ui")?.todo_update.description).toContain("compact Tool UI rendering");
  });

  it("renders tiny-mcp through display metadata", () => {
    const pi = createMockPi();
    tinyMcp(pi as any);
    toolUi(pi as any);
    flushPipTools(pi as any);
    const mcp = getRegisteredTool(pi, "tiny-mcp");

    expect(mcp.renderShell).toBe("self");
    expect(mcp.renderCall({ search: "files" }, theme, {}).render(80).join("\n")).toContain("› tiny-mcp: search files");
  });
});
