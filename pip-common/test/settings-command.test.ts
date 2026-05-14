import { describe, expect, it } from "vitest";
import pipCommon from "../index.ts";
import { createMockPi } from "../src/testing.ts";
import { createPipSettingsComponent } from "../src/settings-command.ts";
import { createSettingsRegistry, setting } from "../src/settings.ts";

describe("pip settings command", () => {
  it("registers /pip-settings from pip-common extension", () => {
    const pi = createMockPi();
    pipCommon(pi as any);
    expect(pi.commands.has("pip-settings")).toBe(true);
  });

  it("cycles boolean and enum values inline", () => {
    const registry = createSettingsRegistry({}, { persistPath: false });
    registry.registerSection({
      id: "plan-mode",
      title: "Plan Mode",
      settings: {
        enabled: setting.boolean({ label: "Enabled", default: true, order: 1 }),
        behavior: setting.enum({ label: "Default behavior", default: "ask", order: 2, choices: ["ask", "always", "never"] as const }),
      },
    });

    const tui = { renders: 0, requestRender() { this.renders++; } };
    const theme = { fg: (_name: string, text: string) => text };
    const component = createPipSettingsComponent(tui, theme, () => undefined, registry) as any;

    expect(component.render(80).join("\n")).toContain("Enabled:");
    expect(registry.get("plan-mode.enabled")).toBe(true);

    component.handleInput("\r");
    expect(registry.get("plan-mode.enabled")).toBe(false);

    component.handleInput("\u001b[B");
    component.handleInput("\u001b[C");
    expect(registry.get("plan-mode.behavior")).toBe("always");

    component.handleInput("\u001b[D");
    expect(registry.get("plan-mode.behavior")).toBe("ask");
  });

  it("always closes on raw escape, ctrl-c, and ctrl-d", () => {
    for (const key of ["\u001b", "\u0003", "\u0004"]) {
      const registry = createSettingsRegistry({}, { persistPath: false });
      registry.registerSection({ id: "x", title: "X", settings: { enabled: setting.boolean(true) } });
      let closed = false;
      const component = createPipSettingsComponent({ requestRender() {} }, { fg: (_name: string, text: string) => text }, () => { closed = true; }, registry) as any;
      component.handleInput(key);
      expect(closed).toBe(true);
    }
  });
});
