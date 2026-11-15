import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPipToolMetadata, registerPipTool, resetPipToolsForTests } from "../src/pip-tools.ts";
import { createMockCtx, createMockPi, emitEvent } from "../src/testing.ts";

const baseTool = (name: string): any => ({
  name,
  label: name,
  description: name,
  parameters: {},
  promptSnippet: "Test tool",
  promptGuidelines: ["Use the test tool."],
  async execute() {
    return { content: [{ type: "text", text: "ok" }], details: undefined };
  },
});

describe("Pip tool registration and display metadata", () => {
  beforeEach(() => resetPipToolsForTests());

  it("registers the unchanged definition once, synchronously, without scheduling work", () => {
    const pi = createMockPi();
    const register = vi.spyOn(pi, "registerTool");
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      const tool = baseTool("x");
      const metadata = { pluginId: "test", display: { call: () => "summary" } };
      registerPipTool(pi as any, { tool, metadata });
      expect(register).toHaveBeenCalledExactlyOnceWith(tool);
      expect(pi.tools.get("x")).toBe(tool);
      expect(getPipToolMetadata(pi as any, "x")).toBe(metadata);
      expect(timer).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });

  it("passes every declaration directly to Pi, including explicit replacement definitions", () => {
    const pi = createMockPi();
    const register = vi.spyOn(pi, "registerTool");
    registerPipTool(pi as any, { tool: baseTool("x"), metadata: { pluginId: "old" } });
    const replacement = baseTool("x");
    registerPipTool(pi as any, { tool: replacement });
    expect(register).toHaveBeenCalledTimes(2);
    expect(pi.tools.get("x")).toBe(replacement);
    expect(getPipToolMetadata(pi as any, "x")).toBeUndefined();
  });

  it("does not hide registration failures or publish their metadata", () => {
    const pi = createMockPi();
    pi.registerTool = () => { throw new Error("registration failed"); };
    expect(() => registerPipTool(pi as any, { tool: baseTool("x"), metadata: { pluginId: "test" } })).toThrow("registration failed");
    expect(getPipToolMetadata(pi as any, "x")).toBeUndefined();
  });

  it("shares display metadata within a runtime and isolates child runtimes", async () => {
    const owner = createMockPi();
    const sibling = createMockPi();
    sibling.events = owner.events;
    const child = createMockPi();
    expect(getPipToolMetadata(owner as any, "x")).toBeUndefined();
    const metadata = { pluginId: "parent" };
    registerPipTool(sibling as any, { tool: baseTool("x"), metadata });
    registerPipTool(child as any, { tool: baseTool("x"), metadata: { pluginId: "child" } });
    expect(getPipToolMetadata(owner as any, "x")).toBe(metadata);
    expect(getPipToolMetadata(child as any, "x")?.pluginId).toBe("child");
    await emitEvent(sibling, "session_shutdown", {}, createMockCtx());
    expect(getPipToolMetadata(owner as any, "x")).toBeUndefined();
    expect(getPipToolMetadata(child as any, "x")?.pluginId).toBe("child");
  });
});
