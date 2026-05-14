import { describe, expect, it } from "vitest";
import { createSettingsRegistry, setting } from "../src/settings.ts";

describe("settings registry", () => {
  it("applies defaults and validates set values", () => {
    const registry = createSettingsRegistry({ plan: { enabled: "bad" } });
    registry.register("plan", {
      enabled: setting.boolean(true),
      mode: setting.enum("ask", ["ask", "auto"] as const),
    });

    expect(registry.get("plan.enabled")).toBe(true);
    registry.set("plan.enabled", false);
    registry.set("plan.mode", "auto");
    expect(registry.all()).toEqual({ plan: { enabled: false, mode: "auto" } });
  });

  it("registers titled sections and cycles choice values", () => {
    const registry = createSettingsRegistry({}, { persistPath: false });
    registry.registerSection({
      id: "plan-mode",
      title: "Plan Mode",
      settings: {
        enabled: setting.boolean({ label: "Enabled", default: true }),
        behavior: setting.enum({ label: "Default behavior", default: "ask", choices: ["ask", "always", "never"] as const }),
      },
    });

    expect(registry.sections()[0].title).toBe("Plan Mode");
    expect(registry.valueLabel("plan-mode.enabled")).toBe("on");
    registry.cycle("plan-mode.enabled");
    expect(registry.get("plan-mode.enabled")).toBe(false);
    expect(registry.valueLabel("plan-mode.enabled")).toBe("off");
    registry.cycle("plan-mode.behavior");
    expect(registry.get("plan-mode.behavior")).toBe("always");
    registry.reset("plan-mode.behavior");
    expect(registry.get("plan-mode.behavior")).toBe("ask");
  });

  it("rejects unknown or invalid settings", () => {
    const registry = createSettingsRegistry();
    registry.register("x", { count: setting.number(1) });
    expect(() => registry.set("x.count", Number.NaN)).toThrow(/Invalid value/);
    expect(() => registry.get("x.nope")).toThrow(/Unknown setting/);
  });
});
