import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsRegistry, getPipSettingsRegistry, readSettingsFile, registerSettingsSection, setting } from "../src/settings.ts";
import { createMockPi } from "../src/testing.ts";

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

  it("enforces numeric bounds for loaded and programmatic values", () => {
    const registry = createSettingsRegistry({ x: { count: -1 } });
    registry.register("x", { count: setting.number({ default: 2, min: 0, max: 5 }) });

    expect(registry.get("x.count")).toBe(2);
    expect(() => registry.set("x.count", -1)).toThrow(/Invalid value/);
    expect(() => registry.set("x.count", 6)).toThrow(/Invalid value/);
    registry.set("x.count", 0);
    registry.set("x.count", 5);
    expect(registry.get("x.count")).toBe(5);
  });

  it("rejects invalid defaults during registration", () => {
    const registry = createSettingsRegistry();
    expect(() => registry.register("x", { count: setting.number({ default: 8, min: 0, max: 5 }) })).toThrow(/Invalid default value/);
    expect(registry.section("x")).toBeUndefined();
  });

  it("emits one batched notification for changed values", () => {
    const registry = createSettingsRegistry();
    registry.register("x", { enabled: setting.boolean(true), count: setting.number(1) });
    const notifications: any[] = [];
    const unsubscribe = registry.onChange((changes) => notifications.push(changes));

    expect(registry.apply({ x: { enabled: false, count: 2 } })).toHaveLength(2);
    expect(notifications).toEqual([[
      { path: "x.enabled", section: "x", key: "enabled", previousValue: true, value: false },
      { path: "x.count", section: "x", key: "count", previousValue: 1, value: 2 },
    ]]);

    registry.apply({ x: { enabled: false, count: 2 } });
    expect(notifications).toHaveLength(1);
    unsubscribe();
    registry.set("x.enabled", true);
    expect(notifications).toHaveLength(1);
  });

  it("shares settings within one runtime and isolates child runtimes", () => {
    const owner = createMockPi();
    const sibling = createMockPi();
    sibling.events = owner.events;
    const child = createMockPi();
    registerSettingsSection(owner, { id: "x", title: "X", settings: { enabled: setting.boolean(true) } });
    registerSettingsSection(child, { id: "x", title: "X", settings: { enabled: setting.boolean(true) } });

    getPipSettingsRegistry(owner).set("x.enabled", false);

    expect(getPipSettingsRegistry(sibling).get("x.enabled")).toBe(false);
    expect(getPipSettingsRegistry(child).get("x.enabled")).toBe(true);
  });

  it("preserves malformed files and refuses to overwrite them", () => {
    const dir = mkdtempSync(join(tmpdir(), "pip-settings-malformed-"));
    const path = join(dir, "pip-settings.json");
    const malformed = '{"x":';
    writeFileSync(path, malformed);
    try {
      const loaded = readSettingsFile(path);
      expect(loaded.error?.message).toContain(path);
      const registry = createSettingsRegistry(loaded.values, { persistPath: path, loadError: loaded.error });
      registry.register("x", { enabled: setting.boolean(true) });
      expect(readFileSync(path, "utf8")).toBe(malformed);
      expect(() => registry.set("x.enabled", false)).toThrow(/Cannot read/);
      expect(readFileSync(path, "utf8")).toBe(malformed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves unknown sections and writes known changes atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "pip-settings-preserve-"));
    const path = join(dir, "pip-settings.json");
    const initial = { unloaded: { custom: "keep" }, x: { enabled: true, unknownKey: 42 } };
    writeFileSync(path, `${JSON.stringify(initial, null, 2)}\n`);
    try {
      const loaded = readSettingsFile(path);
      const registry = createSettingsRegistry(loaded.values, { persistPath: path, loadError: loaded.error });
      const beforeRegistration = readFileSync(path, "utf8");
      registry.register("x", { enabled: setting.boolean(true) });
      expect(readFileSync(path, "utf8")).toBe(beforeRegistration);

      registry.apply({ x: { enabled: false } });
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ unloaded: { custom: "keep" }, x: { enabled: false, unknownKey: 42 } });
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
