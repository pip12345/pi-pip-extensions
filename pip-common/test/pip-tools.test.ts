import { beforeEach, describe, expect, it } from "vitest";
import { flushPipTools, listPipToolRegistrations, onPipToolRegistrationChange, registerPipTool, registerPipToolFinalizer, resetPipToolsForTests } from "../src/pip-tools.ts";
import { createMockPi } from "../src/testing.ts";

const baseTool = (name: string): any => ({
  name,
  label: name,
  description: name,
  parameters: {} as any,
  async execute() {
    return { content: [{ type: "text", text: "ok" }] };
  },
});

describe("pip tool broker", () => {
  beforeEach(() => resetPipToolsForTests());

  it("registers tools synchronously so resumed sessions can render them immediately", () => {
    const pi = createMockPi();
    registerPipTool(pi as any, { tool: baseTool("x"), metadata: { pluginId: "test" } });
    expect(pi.tools.has("x")).toBe(true);
  });

  it("applies finalizers in order", () => {
    const pi = createMockPi();
    registerPipToolFinalizer({ id: "b", order: 20, finalize: ({ tool }) => ({ ...tool, label: `${tool.label}b` }) });
    registerPipToolFinalizer({ id: "a", order: 10, finalize: ({ tool }) => ({ ...tool, label: `${tool.label}a` }) });
    registerPipTool(pi as any, { tool: baseTool("x"), metadata: { pluginId: "test" } });

    flushPipTools(pi as any);
    expect(pi.tools.get("x").label).toBe("xab");
  });

  it("registers late tools immediately after flush", () => {
    const pi = createMockPi();
    flushPipTools(pi as any);
    registerPipTool(pi as any, { tool: baseTool("late"), metadata: { pluginId: "test" } });
    expect(pi.tools.has("late")).toBe(true);
  });

  it("re-finalizes already registered tools when a finalizer is registered late", () => {
    const pi = createMockPi();
    registerPipTool(pi as any, { tool: baseTool("x"), metadata: { pluginId: "test" } });
    expect(pi.tools.get("x").label).toBe("x");

    registerPipToolFinalizer({ id: "late", finalize: ({ tool }) => ({ ...tool, label: `${tool.label}!` }) });
    expect(pi.tools.get("x").label).toBe("x!");
  });

  it("lists registrations and notifies listeners", () => {
    const pi = createMockPi();
    let changes = 0;
    const off = onPipToolRegistrationChange(() => changes++);
    registerPipTool(pi as any, { tool: baseTool("x"), metadata: { pluginId: "test", label: "X" } });
    expect(changes).toBe(1);
    expect(listPipToolRegistrations().map((registration) => registration.tool.name)).toEqual(["x"]);
    off();
  });
});
