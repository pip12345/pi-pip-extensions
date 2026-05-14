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

  it("rejects unknown or invalid settings", () => {
    const registry = createSettingsRegistry();
    registry.register("x", { count: setting.number(1) });
    expect(() => registry.set("x.count", Number.NaN)).toThrow(/Invalid value/);
    expect(() => registry.get("x.nope")).toThrow(/Unknown setting/);
  });
});
