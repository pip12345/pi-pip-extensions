import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import toolUi from "./index.ts";
import { parseEditDisplayDiff, renderSplitEditDiff, renderUnifiedEditDiff } from "./src/split-diff.ts";
import { toolShellComponent } from "./src/shell.ts";
import todo from "../pi-todo/index.ts";
import tinyMcp from "../pi-tiny-mcp/index.ts";
import subagents from "../pi-subagents/index.ts";
import { createSettingsRegistry, flushPipTools, getPipSettingsRegistry, resetPipToolsForTests, setPipSettingsRegistryForTests, visibleWidth } from "../pip-common/index.ts";
import { createMockPi, getRegisteredTool } from "../pip-common/testing.ts";

const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text } as any;
const markedTheme = { fg: (name: string, text: string) => `<${name}>${text}</${name}>`, bg: (name: string, text: string) => `<bg:${name}>${text}</bg:${name}>`, bold: (text: string) => text } as any;

beforeEach(() => {
  initTheme("dark", false);
  resetPipToolsForTests();
});

describe("pi-tool-ui", () => {
  it("keeps shell background through padding after clipped ANSI content", () => {
    const bgTheme = { bg: (_name: string, text: string) => `\x1b[44m${text}\x1b[0m` } as any;
    const component = toolShellComponent({ render: () => ["\x1b[31mabcdefghi"], invalidate() {} }, bgTheme, { paddingX: 2 });
    const contentLine = component.render(10)[1];
    expect(contentLine).toContain("\x1b[44m");
    expect(contentLine).toMatch(/  \x1b\[0m$/);
    expect(contentLine).not.toContain("\x1b[0m  ");
  });

  it("registers built-in tool ui overrides", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    expect([...pi.tools.keys()]).toEqual(["read", "grep", "find", "ls", "edit"]);
    expect(Object.keys(getPipSettingsRegistry(pi).definition("tool-ui") ?? {})).toEqual(["enabled", "diffLayout", "editDiff"]);
    expect(getPipSettingsRegistry(pi).definition("tool-ui")?.editDiff.description).toContain("diffs");
  });

  it("renders compact read calls", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const read = getRegisteredTool(pi, "read");
    const rendered = read.renderCall({ path: "/tmp/file.ts", offset: 3, limit: 2 }, theme, { expanded: false }).render(80).join("\n");
    expect(rendered).toContain("› read: /tmp/file.ts:3-4");
    expect(rendered).not.toContain("expanded");
  });

  it("preserves full built-in prompt contracts while replacing rendering", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const read = getRegisteredTool(pi, "read");
    const edit = getRegisteredTool(pi, "edit");

    for (const name of ["read", "grep", "find", "ls", "edit"]) expect(getRegisteredTool(pi, name).promptSnippet).toBeTypeOf("string");
    expect(read.promptSnippet).toBe("Read file contents");
    expect(read.promptGuidelines).toContain("Use read to examine files instead of cat or sed.");
    expect(read.renderShell).toBe("self");
    expect(read.renderCall).toBeTypeOf("function");
    expect(edit.promptSnippet).toContain("precise file edits");
    expect(edit.promptGuidelines).toContain("Use edit for precise changes (edits[].oldText must match exactly)");
    expect(edit.renderShell).toBe("self");
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

  it("uses renderer isError and bounds every collapsed failure line", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const grep = getRegisteredTool(pi, "grep");
    expect(grep.renderResult({ content: [{ type: "text", text: "ok" }] }, { expanded: false }, theme, { isError: false }).render(80)).toEqual([]);
    expect(grep.renderResult({ content: [{ type: "text", text: "Error-looking success" }] }, { expanded: false }, theme, { isError: false }).render(80)).toEqual([]);
    const failure = grep.renderResult({ content: [{ type: "text", text: `ENOENT ${"x".repeat(500)}\nmore` }] }, { expanded: false }, theme, { isError: true }).render(500).join("\n");
    expect(failure).toContain("ENOENT");
    expect(failure).not.toContain("more");
    expect(visibleWidth(failure.trimEnd())).toBeLessThanOrEqual(200);
  });

  it("uses renderShell:self for edit instead of patching the built-in preview shell", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const edit = getRegisteredTool(pi, "edit");
    expect(edit.renderShell).toBe("self");
    expect(edit.renderCall).toBeTypeOf("function");
    expect(edit.renderResult).toBeTypeOf("function");
    expect(edit.prepareArguments).toBeTypeOf("function");
    const rendered = edit.renderCall({ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }, theme, {}).render(80).join("\n");
    expect(rendered).toContain("edit a.ts 1 edit");
    expect(rendered).not.toContain("›");
  });

  it("renders the edit header as a colored tool title", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const edit = getRegisteredTool(pi, "edit");
    const rendered = edit.renderCall({ path: "a.ts", edits: [] }, markedTheme, { isPartial: true }).render(80).join("\n");

    expect(rendered).toContain("<bg:toolPendingBg>");
    expect(rendered).not.toContain("<bg:toolSuccessBg>");
    expect(rendered).toContain("<toolTitle>edit</toolTitle>");
    expect(rendered).toContain("<muted>a.ts</muted>");
  });

  it("updates edit header background after completion", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const edit = getRegisteredTool(pi, "edit");

    const success = edit.renderCall({ path: "a.ts", edits: [] }, markedTheme, { isPartial: false, isError: false }).render(80).join("\n");
    const error = edit.renderCall({ path: "a.ts", edits: [] }, markedTheme, { isPartial: false, isError: true }).render(80).join("\n");

    expect(success).toContain("<bg:toolSuccessBg>");
    expect(success).not.toContain("<bg:toolPendingBg>");
    expect(error).toContain("<bg:toolErrorBg>");
  });

  it("uses the default edit shell and renderer when edit diff is disabled", () => {
    resetPipToolsForTests();
    const pi = createMockPi();
    setPipSettingsRegistryForTests(pi, createSettingsRegistry({ "tool-ui": { enabled: true, editDiff: false } }, { persistPath: false }));
    toolUi(pi as any);
    const edit = getRegisteredTool(pi, "edit");
    const args = { path: "a.ts", edits: [] };
    const rendered = edit.renderCall(args, markedTheme, { state: {}, args, cwd: process.cwd(), isPartial: false, isError: false, expanded: false }).render(80).join("\n");

    expect(edit.renderShell).toBe("default");
    expect(rendered).not.toContain("<bg:toolSuccessBg>");
  });

  it("renders split edit diffs as result output without depending on call component internals", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const edit = getRegisteredTool(pi, "edit");
    const diff = " 1 same\n-2 old value\n+2 new value\n 3 tail";
    const resultComponent = edit.renderResult({ content: [], details: { diff } }, { expanded: false }, theme, { state: {}, args: { path: "a.ts", edits: [] }, cwd: process.cwd(), isError: false });
    const lines = resultComponent.render(140);
    const rendered = lines.join("\n");
    expect(lines[0]).toContain("diff +1 -1");
    expect(rendered).toContain("diff +1 -1");
    expect(rendered).toContain("old value");
    expect(rendered).toContain("new value");
    expect(rendered).toContain("│");
  });

  it("shows authoritative edit errors instead of a stale success diff", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const edit = getRegisteredTool(pi, "edit");
    const rendered = edit.renderResult(
      { content: [{ type: "text", text: "Path not found: missing.ts\ndetails" }], details: { diff: "-old\n+new" } },
      { expanded: false },
      theme,
      { isError: true },
    ).render(100).join("\n");
    expect(rendered).toContain("Path not found: missing.ts");
    expect(rendered).not.toContain("+new");
  });

  it("never renders edit diff lines wider than the provided width", () => {
    const longOld = "old " + "x".repeat(200);
    const longNew = "new " + "界".repeat(100);
    const diff = ` 1 same\n-2 ${longOld}\n+2 ${longNew}\n 3 tail`;
    const split = renderSplitEditDiff(diff, 117, theme, { maxLines: 80 });
    const unified = renderUnifiedEditDiff(diff, 117, theme, { maxLines: 80 });

    expect(split?.join("\n")).toContain("│");
    expect(split?.every((line: string) => visibleWidth(line) <= 117)).toBe(true);
    expect(unified.every((line: string) => visibleWidth(line) <= 117)).toBe(true);
  });

  it("expands tabs before edit diff width calculations", () => {
    const diff = [
      " 52 \topenCmd := newOpenCommand(app)",
      " 53 \tvar shorthandContinue bool",
      " 54 \tvar shorthandProfile string",
      "+55 \tvar shorthandRebuild bool",
      " 56 \troot := &cobra.Command{",
      " 57 \t\tUse:           \"devbox [folder]\",",
      " 58 \t\tShort:         \"Run coding harnesses in managed Docker containers\",",
    ].join("\n");
    const split = renderSplitEditDiff(diff, 186, theme, { maxLines: 80 });
    const unified = renderUnifiedEditDiff(diff, 186, theme, { maxLines: 80 });

    expect(split?.every((line: string) => visibleWidth(line) <= 186)).toBe(true);
    expect(unified.every((line: string) => visibleWidth(line) <= 186)).toBe(true);
  });

  it("marks implicit gaps when displayed edit diff line numbers jump", () => {
    const diff = [
      " 25 before",
      " 26 before",
      " 27 before",
      " 30 after-gap",
      " 31 after-gap",
      " 35 later-gap",
    ].join("\n");
    const rendered = renderSplitEditDiff(diff, 120, theme, { maxLines: 80 });
    const gapRows = rendered?.filter((line) => line.includes("..."));

    expect(gapRows).toHaveLength(2);
  });

  it("tracks new-side line numbers after insertion blocks", () => {
    const rows = parseEditDisplayDiff([
      " 21 before",
      " 22 before",
      "+23 inserted-a",
      "+24 inserted-b",
      " 23 shifted-context",
    ].join("\n"));

    expect(rows?.at(-1)).toMatchObject({ kind: "context", oldNo: "23", newNo: "25" });
  });

  it("tracks new-side line numbers after deletion blocks", () => {
    const rows = parseEditDisplayDiff([
      " 21 before",
      " 22 before",
      "-23 deleted-a",
      "-24 deleted-b",
      " 25 shifted-context",
    ].join("\n"));

    expect(rows?.at(-1)).toMatchObject({ kind: "context", oldNo: "25", newNo: "23" });
  });

  it("caches final edit result shell renders by width until invalidated", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const edit = getRegisteredTool(pi, "edit");
    const diff = " 1 same\n-2 old value\n+2 new value\n 3 tail";
    const component = edit.renderResult({ content: [], details: { diff } }, { expanded: false }, theme, { state: {}, args: { path: "a.ts", edits: [] }, cwd: process.cwd(), isError: false });

    const first = component.render(140);
    const second = component.render(140);
    const differentWidth = component.render(100);
    component.invalidate?.();
    const afterInvalidate = component.render(140);

    expect(second).toBe(first);
    expect(differentWidth).not.toBe(first);
    expect(afterInvalidate).not.toBe(first);
    expect(afterInvalidate.every((line: string) => visibleWidth(line) <= 140)).toBe(true);
  });

  it("reuses edit result components through context.lastComponent", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const edit = getRegisteredTool(pi, "edit");
    const diff = " 1 same\n-2 old value\n+2 new value\n 3 tail";
    const result = { content: [], details: { diff } };
    const context: any = { state: {}, args: { path: "a.ts", edits: [] }, cwd: process.cwd(), isError: false, lastComponent: undefined };

    const first = edit.renderResult(result, { expanded: false }, theme, context);
    context.lastComponent = first;
    const second = edit.renderResult(result, { expanded: false }, theme, context);
    const firstLines = second.render(140);
    const secondLines = second.render(140);

    expect(second).toBe(first);
    expect(secondLines).toBe(firstLines);
    expect(secondLines.every((line: string) => visibleWidth(line) <= 140)).toBe(true);
  });

  it("renders self-owned split edit diffs within the provided width", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    const edit = getRegisteredTool(pi, "edit");
    const diff = [
      " 51 openCmd := newOpenCommand(app)",
      " 52 var shorthandContinue bool",
      " 53 var shorthandProfile string",
      "+55 var shorthandRebuild bool",
      " 56 root := &cobra.Command{",
      " 57 Use:           \"devbox [folder]\",",
      " 58 Short:         \"Run coding harnesses in managed Docker containers\",",
      " 73 }",
      " 74 if shorthandProfile != \"\" {",
      " 75 openArgs = append(openArgs, \"--profile\", shorthandProfile)",
      " 76 }",
      "+78 if shorthandRebuild {",
      "+79 openArgs = append(openArgs, \"--rebuild\")",
      "+80 }",
      " 77 openCmd.SetContext(cmd.Context())",
      " 78 openCmd.SetArgs(openArgs)",
      " 79 if err := openCmd.ParseFlags(openArgs); err != nil {",
      " 80 return err",
      " 107 root.Flags().BoolVarP(&shorthandContinue, \"continue\", \"c\", false, \"Continue the last harness session\")",
    ].join("\n");

    const rendered = edit.renderResult({ content: [], details: { diff } }, { expanded: false }, theme, { state: {}, args: { path: "internal/cli/app.go", edits: [] }, cwd: process.cwd(), isError: false }).render(190);

    expect(rendered.join("\n")).toContain("│");
    expect(rendered.every((line: string) => visibleWidth(line) <= 190)).toBe(true);
  });

  it("falls back to colored unified edit diffs on narrow terminals", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    getPipSettingsRegistry(pi).set("tool-ui.diffLayout", "auto");
    const edit = getRegisteredTool(pi, "edit");
    const diff = " 1 same\n-2 old value\n+2 new value\n 3 tail";
    const rendered = edit.renderResult({ content: [], details: { diff } }, { expanded: true }, markedTheme, { state: {}, args: { path: "a.ts", edits: [] }, cwd: process.cwd(), isError: false }).render(80).join("\n");
    expect(rendered).toContain("<bg:toolSuccessBg>");
    expect(rendered).toContain("<toolDiffRemoved>-2 old value</toolDiffRemoved>");
    expect(rendered).toContain("<toolDiffAdded>+2 new value</toolDiffAdded>");
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
    expect(getPipSettingsRegistry(pi).definition("tool-ui")?.todo_write).toBeUndefined();
  });

  it("display metadata rendering is load-order safe before flush", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    todo(pi as any);
    flushPipTools(pi as any);
    const update = getRegisteredTool(pi, "todo_update");

    expect(update.renderShell).toBe("self");
    expect(update.renderCall({ updates: [{ match: "x", status: "done" }] }, theme, { expanded: false }).render(80).join("\n")).toContain("› todo_update: 1 updates");
    expect(getPipSettingsRegistry(pi).definition("tool-ui")?.todo_update).toBeUndefined();
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
    expect(mcp.renderResult({ content: [{ type: "text", text: "Connected ghidra." }] }, { expanded: false }, theme, {}).render(80)).toEqual([]);
    const error = mcp.renderResult({ content: [{ type: "text", text: "ENOENT: nope\nmore" }] }, { expanded: false }, theme, { isError: true }).render(80).join("\n");
    expect(error).toContain("ENOENT: nope");
    expect(error).not.toContain("⚠");
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
    expect(getPipSettingsRegistry(pi).definition("tool-ui")?.subagent).toBeUndefined();
  });
});
