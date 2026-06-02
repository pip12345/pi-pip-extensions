import { describe, expect, it } from "vitest";
import pipFooter, { __test } from "./index.ts";
import { createMockCtx, createMockPi, emitEvent } from "../pip-common/testing.ts";
import { pipSettings } from "../pip-common/index.ts";

const theme = { fg: (_name: string, text: string) => text };

describe("pi-pip-footer", () => {
  it("registers footer/token lifecycle handlers", () => {
    const pi = createMockPi();
    pipFooter(pi as any);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("agent_start")).toBe(true);
    expect(pi.handlers.has("message_end")).toBe(true);
    expect(pi.handlers.has("model_select")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);
  });

  it("detects quota providers", () => {
    expect(__test.detectProvider("openai", "auto")).toBe("codex");
    expect(__test.detectProvider("anthropic", "auto")).toBe("anthropic");
    expect(__test.detectProvider("github-copilot", "auto")).toBe("copilot");
    expect(__test.detectProvider("whatever", "codex")).toBe("codex");
    expect(__test.detectProvider("openai", "off")).toBeNull();
  });

  it("shows a zero token baseline while first assistant response is pending", async () => {
    const pi = createMockPi();
    pipFooter(pi as any);
    const ctx = createMockCtx({ model: { contextWindow: 272_000 } });

    await emitEvent(pi, "session_start", {}, ctx);
    const factory = ctx.ui.widgets.get(__test.WIDGET_KEY);
    const component = factory({ requestRender() {} }, theme);
    expect(component.render(80)).toEqual(["↓:0 ↑:0 ↻:0 · $0"]);

    await emitEvent(pi, "turn_start", {}, ctx);
    expect(component.render(80)[0]).toMatch(/^↓:0 ↑:0 ↻:0 · \$0  [◐◓◑◒]$/);

    await emitEvent(pi, "session_shutdown", {}, ctx);
  });

  it("can hide token counter cost", async () => {
    pipSettings.set("pi-pip-footer.showTokenCost", false);
    const pi = createMockPi();
    pipFooter(pi as any);
    const ctx = createMockCtx({ model: { contextWindow: 272_000 } });

    await emitEvent(pi, "session_start", {}, ctx);
    const factory = ctx.ui.widgets.get(__test.WIDGET_KEY);
    const component = factory({ requestRender() {} }, theme);
    expect(component.render(80)).toEqual(["↓:0 ↑:0 ↻:0"]);
    pipSettings.set("pi-pip-footer.showTokenCost", true);
    await emitEvent(pi, "session_shutdown", {}, ctx);
  });

  it("renders settled live usage in the token widget", async () => {
    const pi = createMockPi();
    pipFooter(pi as any);
    const ctx = createMockCtx({ model: { contextWindow: 272_000 } });
    await emitEvent(pi, "session_start", {}, ctx);
    await emitEvent(pi, "message_end", { message: { role: "assistant", usage: { input: 1000, output: 2000, cacheRead: 3000, cost: { total: 0.04 } } } }, ctx);
    const factory = ctx.ui.widgets.get(__test.WIDGET_KEY);
    const component = factory({ requestRender() {} }, theme);
    expect(component.render(120)[0]).toContain("↓:1k ↑:2k ↻:3k · $0.04");
    await emitEvent(pi, "session_shutdown", {}, ctx);
  });
});
