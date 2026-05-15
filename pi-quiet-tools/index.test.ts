import { beforeEach, describe, expect, it } from "vitest";
import { Container } from "@earendil-works/pi-tui";
import quietTools from "./index.ts";
import todo from "../pi-todo/index.ts";
import { flushPipTools, pipSettings, resetPipToolsForTests } from "pip-common";
import { createMockPi, getRegisteredTool } from "pip-common/testing";

const theme = { fg: (_name: string, text: string) => text };

beforeEach(() => resetPipToolsForTests());

describe("pi-quiet-tools", () => {
  it("registers built-in quiet tool overrides", () => {
    const pi = createMockPi();
    quietTools(pi as any);
    expect([...pi.tools.keys()]).toEqual(["read", "grep", "find", "ls"]);
  });

  it("renders compact read calls", () => {
    const pi = createMockPi();
    quietTools(pi as any);
    const read = getRegisteredTool(pi, "read");
    const rendered = read.renderCall({ path: "/tmp/file.ts", offset: 3, limit: 2 }, theme, { expanded: false }).render(80).join("\n");
    expect(rendered).toContain("› read: /tmp/file.ts:3-4");
    expect(rendered).not.toContain("expanded");
  });

  it("warns when quiet tool output is globally expanded", () => {
    const pi = createMockPi();
    quietTools(pi as any);
    const read = getRegisteredTool(pi, "read");
    const rendered = read.renderCall({ path: "/tmp/file.ts" }, theme, { expanded: true }).render(80).join("\n");
    expect(rendered).toContain("› read: /tmp/file.ts");
    expect(rendered).toContain("expanded");
  });

  it("hides successful collapsed results but shows errors", () => {
    const pi = createMockPi();
    quietTools(pi as any);
    const grep = getRegisteredTool(pi, "grep");
    expect(grep.renderResult({ content: [{ type: "text", text: "ok" }] }, { expanded: false }, theme).render(80)).toEqual([]);
    expect(grep.renderResult({ content: [{ type: "text", text: "Error: nope\nmore" }] }, { expanded: false }, theme).render(80).join("\n")).toContain("Error: nope");
  });

  it("removes blank lines between consecutive collapsed quiet tools", () => {
    const pi = createMockPi();
    quietTools(pi as any);

    const container = new Container();
    class ToolExecutionComponent {
      toolName = "grep";
      expanded = false;
      constructor(private readonly label: string) {}
      render() { return ["", this.label, ""]; }
      invalidate() {}
    }
    container.addChild(new ToolExecutionComponent("one") as any);
    container.addChild({ render: () => [""], invalidate() {} } as any);
    container.addChild(new ToolExecutionComponent("two") as any);

    expect(container.render(80)).toEqual(["", "one", "two", ""]);
  });

  it("quiet-renders todo tools when both plugins are loaded", () => {
    const pi = createMockPi();
    todo(pi as any);
    quietTools(pi as any);
    flushPipTools(pi as any);
    const write = getRegisteredTool(pi, "todo_write");

    expect(write.renderShell).toBe("self");
    expect(write.renderCall({ todos: [{ text: "x" }] }, theme, { expanded: false }).render(80).join("\n")).toContain("› todo_write: 1 todos");
    expect(write.renderResult({ content: [{ type: "text", text: "Set 1 todo" }], details: { todos: [{ id: 1, text: "x", status: "pending" }] } }, { expanded: false }, theme, {}).render(80)).toEqual([]);
    expect(pipSettings.definition("quiet-tools")?.todo_write.description).toContain("compact rendering");
  });

  it("quiet todo rendering is load-order safe", () => {
    const pi = createMockPi();
    quietTools(pi as any);
    todo(pi as any);
    flushPipTools(pi as any);
    const update = getRegisteredTool(pi, "todo_update");

    expect(update.renderShell).toBe("self");
    expect(update.renderCall({ updates: [{ match: "x", status: "done" }] }, theme, { expanded: false }).render(80).join("\n")).toContain("› todo_update: 1 updates");
    expect(pipSettings.definition("quiet-tools")?.todo_update.description).toContain("compact rendering");
  });
});
