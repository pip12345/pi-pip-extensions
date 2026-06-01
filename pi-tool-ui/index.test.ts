import { createEditToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import toolUi from "./index.ts";
import todo from "../pi-todo/index.ts";
import tinyMcp from "../pi-tiny-mcp/index.ts";
import subagents from "../pi-subagents/index.ts";
import { flushPipTools, pipSettings, resetPipToolsForTests } from "../pip-common/index.ts";
import { createMockPi, getRegisteredTool } from "../pip-common/testing.ts";

const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text } as any;

beforeEach(() => {
  initTheme("dark", false);
  resetPipToolsForTests();
});

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

  it("registers minimal built-in shims instead of cloning full Pi render definitions", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const read = getRegisteredTool(pi, "read");
    const edit = getRegisteredTool(pi, "edit");

    expect(read.promptSnippet).toBeUndefined();
    expect(read.promptGuidelines).toBeUndefined();
    expect(read.renderShell).toBe("self");
    expect(read.renderCall).toBeTypeOf("function");
    expect(edit.promptSnippet).toBeUndefined();
    expect(edit.promptGuidelines).toBeUndefined();
    expect(edit.renderShell).toBeUndefined();
    expect(edit.renderCall).toBeTypeOf("function");
    expect(edit.renderResult).toBeTypeOf("function");
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

  it("wraps edit call rendering so previews can be split without replacing the built-in shell", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const edit = getRegisteredTool(pi, "edit");
    expect(edit.renderShell).toBeUndefined();
    expect(edit.renderCall).toBeTypeOf("function");
    expect(edit.renderResult).toBeTypeOf("function");
    expect(edit.prepareArguments).toBeTypeOf("function");
  });

  it("renders split edit diffs in the call preview as soon as the built-in preview exists", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const edit = getRegisteredTool(pi, "edit");
    const diff = " 1 same\n-2 old value\n+2 new value\n 3 tail";
    const args = { path: "a.ts", edits: [] };
    const state = {};
    const context = { state, args, cwd: process.cwd(), isError: false, argsComplete: false, invalidate: () => {} };
    edit.renderCall(args, theme, context);
    (state as any).callComponent.preview = { diff, firstChangedLine: 2 };

    const callComponent = edit.renderCall(args, theme, context);
    const rendered = callComponent.render(140).join("\n");

    expect(rendered).toContain("new value");
    expect(rendered).toContain("│");
  });

  it("renders split edit diffs as result output without depending on call component internals", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const edit = getRegisteredTool(pi, "edit");
    const diff = " 1 same\n-2 old value\n+2 new value\n 3 tail";
    const resultComponent = edit.renderResult({ content: [], details: { diff } }, { expanded: false }, theme, { state: {}, args: { path: "a.ts", edits: [] }, cwd: process.cwd(), isError: false });
    const rendered = resultComponent.render(140).join("\n");
    expect(rendered).toContain("diff +1 -1");
    expect(rendered).toContain("old value");
    expect(rendered).toContain("new value");
    expect(rendered).toContain("│");
  });

  it("renders split edit diffs in the built-in call preview without duplicate result output", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const edit = getRegisteredTool(pi, "edit");
    const diff = " 1 same\n-2 old value\n+2 new value\n 3 tail";
    const args = { path: "a.ts", edits: [] };
    const state = {};
    const context = { state, args, cwd: process.cwd(), isError: false };
    createEditToolDefinition(process.cwd()).renderCall?.(args, theme, { ...context, argsComplete: false, invalidate: () => {} } as any);

    const resultComponent = edit.renderResult({ content: [], details: { diff } }, { expanded: false }, theme, context);

    expect(resultComponent.render(140)).toEqual([]);
    const callRendered = (state as any).callComponent.render(140).join("\n");
    expect(callRendered).toContain("new value");
    expect(callRendered).toContain("│");
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

  it("display metadata rendering is load-order safe before flush", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    todo(pi as any);
    flushPipTools(pi as any);
    const update = getRegisteredTool(pi, "todo_update");

    expect(update.renderShell).toBe("self");
    expect(update.renderCall({ updates: [{ match: "x", status: "done" }] }, theme, { expanded: false }).render(80).join("\n")).toContain("› todo_update: 1 updates");
    expect(pipSettings.definition("tool-ui")?.todo_update.description).toContain("compact Tool UI rendering");
  });

  it("display metadata rendering is re-applied when Tool UI loads after pip tools registered", () => {
    const pi = createMockPi();
    todo(pi as any);
    expect(getRegisteredTool(pi, "todo_update").renderShell).toBeUndefined();

    toolUi(pi as any);
    const update = getRegisteredTool(pi, "todo_update");
    expect(update.renderShell).toBe("self");
    expect(update.renderCall({ updates: [{ match: "x", status: "done" }] }, theme, { expanded: false }).render(80).join("\n")).toContain("› todo_update: 1 updates");
    expect(update.renderResult({ content: [{ type: "text", text: "Updated 1 todo" }], details: { todos: [] } }, { expanded: false }, theme, {}).render(80)).toEqual([]);
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

  it("does not compact-render subagent just because it has display metadata", () => {
    const pi = createMockPi();
    subagents(pi as any);
    const before = getRegisteredTool(pi, "subagent");

    toolUi(pi as any);
    flushPipTools(pi as any);
    const tool = getRegisteredTool(pi, "subagent");

    expect(tool.renderShell).toBe(before.renderShell);
    expect(tool.renderCall).toBe(before.renderCall);
    expect(tool.renderResult).toBe(before.renderResult);
    expect(pipSettings.definition("tool-ui")?.subagent).toBeUndefined();
  });
});
