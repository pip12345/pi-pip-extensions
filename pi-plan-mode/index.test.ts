import { beforeEach, describe, expect, it } from "vitest";
import planMode, { __test, isReadOnlyBash, shouldBlockTool, stateFromBranch } from "./index.ts";
import { pipSettings } from "../pip-common/index.ts";
import { createMockCtx, createMockPi, emitEvent, runCommand } from "../pip-common/testing.ts";

function resetPlanSettings() {
  pipSettings.set("plan-mode.enabled", true);
  pipSettings.set("plan-mode.bashPolicy", "readonly");
  pipSettings.set("plan-mode.unknownTools", "allow");
  pipSettings.set("plan-mode.indicator", true);
}

beforeEach(() => {
  resetPlanSettings();
});

describe("pi-plan-mode", () => {
  it("registers settings and /plan command", () => {
    const pi = createMockPi();
    planMode(pi as any);
    expect(pi.commands.has("plan")).toBe(true);
    expect(pipSettings.section(__test.SETTINGS_ID)?.title).toBe("Plan Mode");
    expect(pipSettings.definition(__test.SETTINGS_ID)?.bashPolicy.description).toContain("read-only bash");
  });

  it("/plan toggles state, widget, and persistence", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    planMode(pi as any);

    await runCommand(pi, "plan", "", ctx);
    expect(pi.entries.at(-1)).toMatchObject({ customType: __test.CUSTOM_TYPE, data: { active: true } });
    expect(ctx.ui.widgets.has(__test.WIDGET_KEY)).toBe(true);

    await runCommand(pi, "plan", "", ctx);
    expect(pi.entries.at(-1)).toMatchObject({ customType: __test.CUSTOM_TYPE, data: { active: false } });
    expect(ctx.ui.widgets.get(__test.WIDGET_KEY)).toBeUndefined();
  });

  it("supports on/off/status commands", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    planMode(pi as any);

    await runCommand(pi, "plan", "on", ctx);
    await runCommand(pi, "plan", "status", ctx);
    expect(ctx.ui.notifications.at(-1).message).toBe("Plan mode is active.");

    await runCommand(pi, "plan", "off", ctx);
    await runCommand(pi, "plan", "status", ctx);
    expect(ctx.ui.notifications.at(-1).message).toBe("Plan mode is inactive.");
  });

  it("restores latest state from branch and respects disabled setting", async () => {
    const pi = createMockPi();
    const branch = [
      { type: "custom", customType: __test.CUSTOM_TYPE, data: { active: false, updatedAt: 1 } },
      { type: "custom", customType: __test.CUSTOM_TYPE, data: { active: true, updatedAt: 2 } },
    ];
    const ctx = createMockCtx({ sessionManager: { getBranch: () => branch } });
    planMode(pi as any);

    await emitEvent(pi, "session_start", {}, ctx);
    expect(ctx.ui.widgets.has(__test.WIDGET_KEY)).toBe(true);

    pipSettings.set("plan-mode.enabled", false);
    await emitEvent(pi, "session_tree", {}, ctx);
    expect(ctx.ui.widgets.get(__test.WIDGET_KEY)).toBeUndefined();
  });

  it("stateFromBranch tolerates mock append entries", () => {
    expect(stateFromBranch([{ customType: __test.CUSTOM_TYPE, data: { active: true, updatedAt: 3 } }])).toEqual({ active: true, updatedAt: 3 });
  });

  it("injects prompt reminder only when active", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    planMode(pi as any);

    expect(await emitEvent(pi, "before_agent_start", { systemPrompt: "base" }, ctx)).toEqual([undefined]);
    await runCommand(pi, "plan", "on", ctx);
    const [result] = await emitEvent(pi, "before_agent_start", { systemPrompt: "base" }, ctx);
    expect(result.systemPrompt).toContain("base");
    expect(result.systemPrompt).toContain("read-only planning mode");
    expect(result.systemPrompt).toContain("Evidence read");
    expect(result.systemPrompt).toContain("Root cause / design owner");
    expect(result.systemPrompt).toContain("Questions, if any, labeled Q1, Q2, Q3");
    expect(result.systemPrompt).toContain("Before finishing the plan, make sure");
    expect(result.systemPrompt).toContain("You have read the owning implementation file(s)");
    expect(result.systemPrompt).toContain("If any evidence item is missing, say what is missing");
    expect(result.systemPrompt).toContain("End with a clear next-step question");
  });

  it("classifies tools without name heuristics", () => {
    const opts = { bashPolicy: "readonly" as const, unknownTools: "allow" as const };
    expect(shouldBlockTool("edit", {}, opts)).toContain("Plan mode active");
    expect(shouldBlockTool("write", {}, opts)).toContain("Plan mode active");
    expect(shouldBlockTool("todo_write", {}, opts)).toContain("Plan mode active");
    expect(shouldBlockTool("todo_update", {}, opts)).toContain("Plan mode active");
    expect(shouldBlockTool("todo_read", {}, opts)).toBeUndefined();
    expect(shouldBlockTool("webfetch", {}, opts)).toBeUndefined();
    expect(shouldBlockTool("websearch", {}, opts)).toBeUndefined();
    expect(shouldBlockTool("custom_update_sounding_tool", {}, opts)).toBeUndefined();
    expect(shouldBlockTool("custom_update_sounding_tool", {}, { ...opts, unknownTools: "block" })).toContain("not explicitly allowed");
  });

  it("enforces tool policy during active plan mode", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    planMode(pi as any);
    await runCommand(pi, "plan", "on", ctx);

    expect((await emitEvent(pi, "tool_call", { toolName: "edit", input: {}, toolCallId: "1" }, ctx))[0]).toMatchObject({ block: true });
    expect((await emitEvent(pi, "tool_call", { toolName: "todo_read", input: {}, toolCallId: "2" }, ctx))[0]).toBeUndefined();

    pipSettings.set("plan-mode.unknownTools", "block");
    expect((await emitEvent(pi, "tool_call", { toolName: "unknown", input: {}, toolCallId: "3" }, ctx))[0]).toMatchObject({ block: true });
  });

  it("allows only readonly bash when configured", () => {
    expect(isReadOnlyBash("ls -la")).toBe(true);
    expect(isReadOnlyBash("git diff -- src")).toBe(true);
    expect(isReadOnlyBash("npm info vitest")).toBe(true);
    expect(isReadOnlyBash("rm -rf dist")).toBe(false);
    expect(isReadOnlyBash("cat a > b")).toBe(false);
    expect(isReadOnlyBash("cat file | sh")).toBe(false);
    expect(isReadOnlyBash("echo x | tee file")).toBe(false);
    expect(isReadOnlyBash("ls && rm x")).toBe(false);
    expect(isReadOnlyBash("npm audit fix")).toBe(false);
    expect(isReadOnlyBash("git branch -D foo")).toBe(false);
    expect(isReadOnlyBash("git branch --show-current")).toBe(true);
  });

  it("blocks bash according to settings", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    planMode(pi as any);
    await runCommand(pi, "plan", "on", ctx);

    expect((await emitEvent(pi, "tool_call", { toolName: "bash", input: { command: "git status" }, toolCallId: "1" }, ctx))[0]).toBeUndefined();
    expect((await emitEvent(pi, "tool_call", { toolName: "bash", input: { command: "git commit -m x" }, toolCallId: "2" }, ctx))[0]).toMatchObject({ block: true });

    pipSettings.set("plan-mode.bashPolicy", "block");
    expect((await emitEvent(pi, "tool_call", { toolName: "bash", input: { command: "ls" }, toolCallId: "3" }, ctx))[0]).toMatchObject({ block: true });
  });

  it("renders an above-editor widget when active", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    const theme = { fg: (_name: string, text: string) => text };
    planMode(pi as any);

    expect(ctx.ui.widgets.get(__test.WIDGET_KEY)).toBeUndefined();
    await runCommand(pi, "plan", "on", ctx);
    const factory = ctx.ui.widgets.get(__test.WIDGET_KEY);
    expect(factory).toBeTruthy();
    expect(factory({}, theme).render(80).join("\n")).toContain("plan mode — edits blocked");
  });

  it("clears widget on shutdown and when indicator setting is off", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    planMode(pi as any);
    await runCommand(pi, "plan", "on", ctx);
    expect(ctx.ui.widgets.has(__test.WIDGET_KEY)).toBe(true);

    pipSettings.set("plan-mode.indicator", false);
    await emitEvent(pi, "session_tree", {}, ctx);
    expect(ctx.ui.widgets.get(__test.WIDGET_KEY)).toBeUndefined();

    await emitEvent(pi, "session_shutdown", {}, ctx);
    expect(ctx.ui.widgets.get(__test.WIDGET_KEY)).toBeUndefined();
  });
});
