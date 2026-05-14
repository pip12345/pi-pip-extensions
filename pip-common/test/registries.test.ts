import { describe, expect, it } from "vitest";
import { createCapabilityRegistry } from "../src/capabilities.ts";
import { createPromptRegistry } from "../src/prompt-registry.ts";
import { createStatusBroker } from "../src/status.ts";

describe("prompt registry", () => {
  it("builds enabled providers in priority order", async () => {
    const registry = createPromptRegistry();
    registry.register({ id: "low", priority: 1, build: () => "low" });
    registry.register({ id: "high", priority: 10, build: () => "high" });
    registry.register({ id: "off", enabled: false, build: () => "off" });
    expect(await registry.buildAll({})).toBe("high\n\nlow");
  });
});

describe("capability registry", () => {
  it("renders capabilities", () => {
    const registry = createCapabilityRegistry();
    registry.register({ id: "todo", title: "Todo", commands: ["/todo"], tools: ["todo_add"], prompt: "Track work." });
    expect(registry.render()).toContain("Todo");
    expect(registry.render()).toContain("/todo");
  });
});

describe("status broker", () => {
  it("renders statuses by priority", () => {
    const status = createStatusBroker();
    status.set("low", "LOW", { priority: 1 });
    status.set("high", "HIGH", { priority: 10 });
    expect(status.render("|")).toBe("HIGH|LOW");
  });
});
