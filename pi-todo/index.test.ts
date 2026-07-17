import { beforeEach, describe, expect, it } from "vitest";
import todoExtension, { __test, renderCompactTodos, stateFromBranch } from "./index.ts";
import { createMockCtx, createMockPi, emitEvent, getRegisteredTool, runCommand } from "../pip-common/testing.ts";
import { flushPipTools, getPipSettingsRegistry, resetPipToolsForTests, stripAnsi } from "../pip-common/index.ts";

const theme = {
  fg: (_name: string, text: string) => text,
};

beforeEach(() => resetPipToolsForTests());

describe("pi-todo", () => {
  it("registers settings, tools, and command", () => {
    const pi = createMockPi();
    todoExtension(pi as any);
    flushPipTools(pi as any);

    expect(getRegisteredTool(pi, "todo_write")).toBeTruthy();
    expect(getRegisteredTool(pi, "todo_update")).toBeTruthy();
    expect(getRegisteredTool(pi, "todo_read")).toBeTruthy();
    expect(pi.commands.has("todo")).toBe(true);
    const settings = getPipSettingsRegistry(pi);
    expect(settings.section(__test.SETTINGS_ID)?.title).toBe("Todo");
    expect(settings.get("todo.enabled")).toBe(true);
    expect(settings.get("todo.compactRows")).toBe("4");
    expect(settings.definition("todo")?.compactRows.description).toContain("Fixed height");
  });

  it("applies enabled changes to the widget, tools, and command", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx({ entries: [{ type: "custom", customType: __test.CUSTOM_TYPE, data: { todos: [{ id: 1, text: "One", status: "pending" }], nextId: 2, updatedAt: 1 } }] });
    todoExtension(pi as any);
    flushPipTools(pi as any);
    await emitEvent(pi, "session_start", {}, ctx);
    expect(ctx.ui.widgets.get(__test.WIDGET_KEY)).toBeTruthy();

    getPipSettingsRegistry(pi).set("todo.enabled", false);
    expect(ctx.ui.widgets.get(__test.WIDGET_KEY)).toBeUndefined();
    const result = await getRegisteredTool(pi, "todo_write").execute("call", { todos: [{ text: "Blocked" }] }, undefined, undefined, ctx);
    expect(result.details.disabled).toBe(true);
    expect(pi.entries).toHaveLength(0);
    await runCommand(pi, "todo", "", ctx);
    expect(ctx.ui.notifications.at(-1).message).toContain("disabled");
    await emitEvent(pi, "session_shutdown", {}, ctx);
  });

  it("todo_write creates multiple todos, normalizes active, and appends state", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    todoExtension(pi as any);
    flushPipTools(pi as any);

    const write = getRegisteredTool(pi, "todo_write");
    const result = await write.execute("call", { todos: [{ text: "One", status: "active" }, { text: "Two", status: "active" }, { text: "Three" }] }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("3 todos");
    expect(pi.entries).toHaveLength(1);
    expect(pi.entries[0].customType).toBe(__test.CUSTOM_TYPE);
    expect(pi.entries[0].data.todos.map((t: any) => t.status)).toEqual(["active", "pending", "pending"]);
  });

  it("todo_update updates by id and match while keeping one active", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    todoExtension(pi as any);
    flushPipTools(pi as any);
    await getRegisteredTool(pi, "todo_write").execute("call", { todos: [{ text: "First" }, { text: "Second" }, { text: "Third" }] }, undefined, undefined, ctx);

    const update = getRegisteredTool(pi, "todo_update");
    const result = await update.execute("call", { updates: [{ id: 1, status: "active" }, { match: "Second", status: "active", text: "Second task" }, { match: "Third", status: "done" }] }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("Updated 3 todos");
    const todos = pi.entries.at(-1).data.todos;
    expect(todos.map((t: any) => [t.text, t.status])).toEqual([
      ["First", "pending"],
      ["Second task", "active"],
      ["Third", "done"],
    ]);
  });

  it("todo_update reports misses and does not append unchanged state", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    todoExtension(pi as any);
    flushPipTools(pi as any);
    await getRegisteredTool(pi, "todo_write").execute("call", { todos: [{ text: "Only" }] }, undefined, undefined, ctx);
    const before = pi.entries.length;

    const update = getRegisteredTool(pi, "todo_update");
    const result = await update.execute("call", { updates: [{ id: 999, status: "done" }, { match: "", status: "active" }, { match: "Only" }] }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("Updated 0 todos");
    expect(result.details.errors).toContain("No todo matched id #999");
    expect(result.details.errors).toContain("Update requires id or match");
    expect(result.details.errors).toContain('No change specified for "Only"');
    expect(pi.entries).toHaveLength(before);
  });

  it("todo_read returns a compact list", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    todoExtension(pi as any);
    flushPipTools(pi as any);
    await getRegisteredTool(pi, "todo_write").execute("call", { todos: [{ text: "Read me", status: "active" }] }, undefined, undefined, ctx);

    const result = await getRegisteredTool(pi, "todo_read").execute("call", {}, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("[active] #1 Read me");
  });

  it("reconstructs state from latest custom entry on branch", async () => {
    const pi = createMockPi();
    const branch = [
      { type: "custom", customType: __test.CUSTOM_TYPE, data: { todos: [{ id: 1, text: "Old", status: "done" }], nextId: 2, updatedAt: 1 } },
      { type: "custom", customType: __test.CUSTOM_TYPE, data: { todos: [{ id: 2, text: "New", status: "active" }], nextId: 3, updatedAt: 2 } },
    ];
    const ctx = createMockCtx({ sessionManager: { getBranch: () => branch } });
    todoExtension(pi as any);
    flushPipTools(pi as any);

    await emitEvent(pi, "session_start", {}, ctx);
    const result = await getRegisteredTool(pi, "todo_read").execute("call", {}, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("New");
    expect(result.content[0].text).not.toContain("Old");
  });

  it("stateFromBranch tolerates mock append entries", () => {
    const state = stateFromBranch([{ customType: __test.CUSTOM_TYPE, data: { todos: [{ text: "Mock", status: "active" }], nextId: 2 } }]);
    expect(state.todos).toEqual([{ id: 2, text: "Mock", status: "active" }]);
  });

  it("renders no widget lines when no todos", () => {
    expect(renderCompactTodos({ todos: [], nextId: 1, updatedAt: 0 }, 80, theme)).toEqual([]);
  });

  it("renders fixed rows with the soft single-item capsule", () => {
    const lines = renderCompactTodos({ todos: [{ id: 1, text: "Only task", status: "active" }], nextId: 2, updatedAt: 0 }, 80, theme, { rows: 4 });
    expect(lines).toHaveLength(4);
    expect(stripAnsi(lines[0])).toBe("╴ ● #1 Only task");
    expect(lines.slice(1)).toEqual(["", "", ""]);
  });

  it("renders multi-item growing capsule and overflow", () => {
    const lines = renderCompactTodos(
      {
        todos: [
          { id: 1, text: "Done", status: "done" },
          { id: 2, text: "Active", status: "active" },
          { id: 3, text: "Pending", status: "pending" },
          { id: 4, text: "Hidden", status: "pending" },
        ],
        nextId: 5,
        updatedAt: 0,
      },
      80,
      theme,
      { rows: 3 }
    );

    expect(stripAnsi(lines[0])).toContain("╭ ✔ #1 Done");
    expect(stripAnsi(lines[1])).toContain("├ ● #2 Active");
    expect(stripAnsi(lines[2])).toContain("╰ … 2 below");
  });

  it("reports todos hidden above and below the active window", () => {
    const lines = renderCompactTodos(
      {
        todos: [
          { id: 1, text: "One", status: "pending" },
          { id: 2, text: "Two", status: "pending" },
          { id: 3, text: "Three", status: "pending" },
          { id: 4, text: "Four", status: "pending" },
          { id: 5, text: "Active", status: "active" },
          { id: 6, text: "Six", status: "pending" },
        ],
        nextId: 7,
        updatedAt: 0,
      },
      80,
      theme,
      { rows: 3 },
    );

    expect(stripAnsi(lines[0])).toContain("#4 Four");
    expect(stripAnsi(lines[1])).toContain("#5 Active");
    expect(stripAnsi(lines[2])).toContain("… 3 above · 1 below");
  });

  it("honors showCompleted never and hideWhenAllDone", () => {
    const state = {
      todos: [
        { id: 1, text: "Done one", status: "done" as const },
        { id: 2, text: "Done two", status: "done" as const },
      ],
      nextId: 3,
      updatedAt: 0,
    };

    expect(renderCompactTodos(state, 80, theme, { rows: 4, showCompleted: "never" })).toEqual([]);
    expect(renderCompactTodos(state, 80, theme, { rows: 4, hideWhenAllDone: true })).toEqual([]);
  });

  it("renders warning glyph for todo_update errors", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    todoExtension(pi as any);
    flushPipTools(pi as any);
    const update = getRegisteredTool(pi, "todo_update");
    const result = await update.execute("call", { updates: [{ id: 123, status: "done" }] }, undefined, undefined, ctx);

    const rendered = update.renderResult(result, {}, theme).render(80).join("\n");
    expect(stripAnsi(rendered)).toContain("⚠ Updated 0 todos");
  });

  it("updates widget after write and clears after command clear", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    todoExtension(pi as any);
    flushPipTools(pi as any);

    await getRegisteredTool(pi, "todo_write").execute("call", { todos: [{ text: "Visible" }] }, undefined, undefined, ctx);
    expect(ctx.ui.widgets.has(__test.WIDGET_KEY)).toBe(true);

    await runCommand(pi, "todo", "clear", ctx);
    expect(ctx.ui.widgets.get(__test.WIDGET_KEY)).toBeUndefined();
  });

  it("/todo invalid ids notify and do not append entries", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    todoExtension(pi as any);
    flushPipTools(pi as any);
    await getRegisteredTool(pi, "todo_write").execute("call", { todos: [{ text: "Visible" }] }, undefined, undefined, ctx);
    const before = pi.entries.length;

    await runCommand(pi, "todo", "done 999", ctx);
    await runCommand(pi, "todo", "delete nope", ctx);

    expect(pi.entries).toHaveLength(before);
    expect(ctx.ui.notifications.map((n: any) => n.message)).toEqual(expect.arrayContaining(["No todo matched id #999", "Todo #nope not found"]));
  });

  it("/todo inspector renders with a border", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    todoExtension(pi as any);
    flushPipTools(pi as any);
    await getRegisteredTool(pi, "todo_write").execute("call", { todos: [{ text: "Visible", status: "active" }] }, undefined, undefined, ctx);

    let component: any;
    ctx.ui.custom = async (factory: any) => {
      component = factory({}, theme, {}, () => undefined);
    };

    await runCommand(pi, "todo", "", ctx);
    const rendered = component.render(80).map(stripAnsi).join("\n");
    expect(rendered).toContain("╭");
    expect(rendered).toContain("Todos");
    expect(rendered).toContain("╰");
    expect(rendered).toContain("● #1 Visible");
  });

  it("/todo inspector follows selection through a terminal-bounded viewport", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    todoExtension(pi as any);
    flushPipTools(pi as any);
    await getRegisteredTool(pi, "todo_write").execute(
      "call",
      { todos: Array.from({ length: 20 }, (_, index) => ({ text: `Task ${index + 1}` })) },
      undefined,
      undefined,
      ctx,
    );

    let component: any;
    ctx.ui.custom = async (factory: any) => {
      component = factory({ terminal: { rows: 15 }, requestRender() {} }, theme, {}, () => undefined);
    };
    await runCommand(pi, "todo", "", ctx);
    for (let index = 1; index < 20; index++) component.handleInput("j");

    const rendered = component.render(80).map(stripAnsi);
    const text = rendered.join("\n");
    expect(text).toContain("› □ #20 Task 20");
    expect(text).toContain("of 20");
    expect(text).not.toContain("#1 Task 1");
    expect(rendered.length).toBeLessThanOrEqual(12);
  });
});
