import { beforeEach, describe, expect, it } from "vitest";
import { flushPipTools, listPipToolRegistrations, onPipToolRegistrationChange, registerPipTool, registerPipToolFinalizer, resetPipToolsForTests } from "../src/pip-tools.ts";
import { createMockCtx, createMockPi, emitEvent } from "../src/testing.ts";

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
    registerPipToolFinalizer(pi as any, { id: "b", order: 20, finalize: ({ tool }) => ({ ...tool, label: `${tool.label}b` }) });
    registerPipToolFinalizer(pi as any, { id: "a", order: 10, finalize: ({ tool }) => ({ ...tool, label: `${tool.label}a` }) });
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

    registerPipToolFinalizer(pi as any, { id: "late", finalize: ({ tool }) => ({ ...tool, label: `${tool.label}!` }) });
    expect(pi.tools.get("x").label).toBe("x!");
  });

  it("lists registrations and notifies listeners", () => {
    const pi = createMockPi();
    let changes = 0;
    const off = onPipToolRegistrationChange(pi as any, () => changes++);
    registerPipTool(pi as any, { tool: baseTool("x"), metadata: { pluginId: "test", label: "X" } });
    expect(changes).toBe(1);
    expect(listPipToolRegistrations(pi as any).map((registration) => registration.tool.name)).toEqual(["x"]);
    off();
  });

  it("disposes its owning registrations on shutdown", async () => {
    const pi = createMockPi();
    registerPipTool(pi as any, { tool: baseTool("x"), metadata: { pluginId: "test" } });
    await emitEvent(pi, "session_shutdown", {}, createMockCtx());
    expect(listPipToolRegistrations(pi as any)).toEqual([]);
  });

  it("prunes stale Pi states without leaking finalizers into a new runtime", () => {
    const stalePi = createMockPi();
    registerPipTool(stalePi as any, { tool: baseTool("old"), metadata: { pluginId: "old" } });
    stalePi.registerTool = () => {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    };

    expect(() => registerPipToolFinalizer(stalePi as any, { id: "late", finalize: ({ tool }) => ({ ...tool, label: `${tool.label}!` }) })).not.toThrow();
    expect(listPipToolRegistrations(stalePi as any)).toEqual([]);

    const freshPi = createMockPi();
    registerPipTool(freshPi as any, { tool: baseTool("fresh"), metadata: { pluginId: "fresh" } });
    expect(freshPi.tools.get("fresh").label).toBe("fresh");
  });

  it("shares finalizers within one runtime and isolates child runtimes", () => {
    const owner = createMockPi();
    const sibling = createMockPi();
    sibling.events = owner.events;
    const child = createMockPi();
    registerPipToolFinalizer(owner as any, { id: "shared", finalize: ({ tool }) => ({ ...tool, label: `${tool.label}!` }) });

    registerPipTool(sibling as any, { tool: baseTool("sibling"), metadata: { pluginId: "sibling" } });
    registerPipTool(child as any, { tool: baseTool("child"), metadata: { pluginId: "child" } });

    expect(sibling.tools.get("sibling").label).toBe("sibling!");
    expect(child.tools.get("child").label).toBe("child");
    expect(listPipToolRegistrations(owner as any).map((registration) => registration.tool.name)).toEqual(["sibling"]);
    expect(listPipToolRegistrations(child as any).map((registration) => registration.tool.name)).toEqual(["child"]);
  });
});
