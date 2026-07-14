import { describe, expect, it } from "vitest";
import { createSettingsRegistry, setting } from "../src/settings.ts";

describe("settings registry", () => {
  it("applies defaults and validates set values", () => {
    const registry = createSettingsRegistry({ sample: { enabled: "bad" } });
    registry.register("sample", {
      enabled: setting.boolean(true),
      mode: setting.enum("ask", ["ask", "auto"] as const),
    });

    expect(registry.get("sample.enabled")).toBe(true);
    registry.set("sample.enabled", false);
    registry.set("sample.mode", "auto");
    expect(registry.all()).toEqual({ sample: { enabled: false, mode: "auto" } });
  });

  it("registers titled sections and cycles choice values", () => {
    const registry = createSettingsRegistry({}, { persistPath: false });
    registry.registerSection({
      id: "example",
      title: "Example",
      settings: {
        enabled: setting.boolean({ label: "Enabled", default: true }),
        behavior: setting.enum({ label: "Default behavior", default: "ask", choices: ["ask", "always", "never"] as const }),
      },
    });

    expect(registry.sections()[0].title).toBe("Example");
    expect(registry.valueLabel("example.enabled")).toBe("on");
    registry.cycle("example.enabled");
    expect(registry.get("example.enabled")).toBe(false);
    expect(registry.valueLabel("example.enabled")).toBe("off");
    registry.cycle("example.behavior");
    expect(registry.get("example.behavior")).toBe("always");
    registry.reset("example.behavior");
    expect(registry.get("example.behavior")).toBe("ask");
  });

  it("rejects unknown or invalid settings", () => {
    const registry = createSettingsRegistry();
    registry.register("x", { count: setting.number(1) });
    expect(() => registry.set("x.count", Number.NaN)).toThrow(/Invalid value/);
    expect(() => registry.get("x.nope")).toThrow(/Unknown setting/);
  });
});
