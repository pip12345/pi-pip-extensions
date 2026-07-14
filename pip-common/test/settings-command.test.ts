import { describe, expect, it } from "vitest";
import pipCommon from "../index.ts";
import { createMockCtx, createMockPi } from "../src/testing.ts";
import { createPipSettingsComponent, registerPipSettingsCommand } from "../src/settings-command.ts";
import { visibleWidth } from "../src/keys.ts";
import { createSettingsRegistry, setting } from "../src/settings.ts";

describe("pip settings command", () => {
  it("registers /pip-settings for the runtime", () => {
    const pi = createMockPi();
    pipCommon(pi as any);
    expect(pi.commands.has("pip-settings")).toBe(true);
  });

  it("bootstraps each Pi runtime only once", async () => {
    const pi = createMockPi();
    const registerCommand = pi.registerCommand;
    let registrations = 0;
    pi.registerCommand = function (name: string, command: any) {
      registrations += 1;
      registerCommand.call(this, name, command);
    };
    pipCommon(pi as any);
    pipCommon(pi as any);
    expect(registrations).toBe(1);
  });

  it("stages boolean and enum values until close", () => {
    const registry = createSettingsRegistry({}, { persistPath: false });
    registry.registerSection({
      id: "example",
      title: "Example",
      settings: {
        enabled: setting.boolean({ label: "Enabled", default: true, order: 1 }),
        behavior: setting.enum({ label: "Default behavior", default: "ask", order: 2, choices: ["ask", "always", "never"] as const }),
      },
    });

    const tui = { renders: 0, requestRender() { this.renders++; } };
    const theme = { fg: (_name: string, text: string) => text };
    let result: any;
    const component = createPipSettingsComponent(tui, theme, (value) => { result = value; }, registry) as any;

    expect(component.render(80).join("\n")).toContain("Enabled:");
    expect(registry.get("example.enabled")).toBe(true);

    component.handleInput("\r");
    expect(registry.get("example.enabled")).toBe(true);
    expect(component.render(80).join("\n")).toContain("unsaved");

    component.handleInput("\u001b[B");
    component.handleInput("\u001b[C");
    component.handleInput("\u001b[D");
    component.handleInput("\u001b");

    expect(result.dirty).toBe(true);
    expect(result.values.example.enabled).toBe(false);
    expect(result.values.example.behavior).toBe("ask");
    expect(registry.get("example.enabled")).toBe(true);
  });

  it("draws the settings box across the full overlay width", () => {
    const registry = createSettingsRegistry({}, { persistPath: false });
    registry.registerSection({ id: "x", title: "X", settings: { enabled: setting.boolean(true) } });
    const component = createPipSettingsComponent({ requestRender() {} }, { fg: (_name: string, text: string) => text }, () => undefined, registry) as any;

    const lines = component.render(140);

    expect(lines.every((line: string) => visibleWidth(line) === 140)).toBe(true);
    expect(visibleWidth(lines[0].trimEnd())).toBe(140);
  });

  it("shows a taller settings list", () => {
    const registry = createSettingsRegistry({}, { persistPath: false });
    registry.registerSection({
      id: "x",
      title: "X",
      settings: Object.fromEntries(Array.from({ length: 34 }, (_, index) => [`setting${index}`, setting.boolean({ label: `Setting ${index}`, default: true, order: index })])),
    });
    const component = createPipSettingsComponent({ terminal: { rows: 60 }, requestRender() {} }, { fg: (_name: string, text: string) => text }, () => undefined, registry) as any;

    const rendered = component.render(100).join("\n");
    const visibleSettingRows = rendered.split("\n").filter((line: string) => /Setting \d+:/.test(line));

    expect(visibleSettingRows.length).toBeGreaterThan(20);
    expect(visibleSettingRows.length).toBe(29);
  });

  it("reduces settings rows on short terminals", () => {
    const registry = createSettingsRegistry({}, { persistPath: false });
    registry.registerSection({
      id: "x",
      title: "X",
      settings: Object.fromEntries(Array.from({ length: 34 }, (_, index) => [`setting${index}`, setting.boolean({ label: `Setting ${index}`, default: true, order: index })])),
    });
    const component = createPipSettingsComponent({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_name: string, text: string) => text }, () => undefined, registry) as any;

    const rendered = component.render(100).join("\n");
    const visibleSettingRows = rendered.split("\n").filter((line: string) => /Setting \d+:/.test(line));

    expect(visibleSettingRows.length).toBe(9);
  });

  it("keeps settings rows stable when selected description appears or disappears", () => {
    const registry = createSettingsRegistry({}, { persistPath: false });
    registry.registerSection({
      id: "x",
      title: "X",
      settings: {
        described: setting.boolean({ label: "Described", default: true, order: 1, description: "Helpful text that should not move the menu rows around." }),
        plain: setting.boolean({ label: "Plain", default: true, order: 2 }),
      },
    });
    const component = createPipSettingsComponent({ requestRender() {} }, { fg: (_name: string, text: string) => text }, () => undefined, registry) as any;

    const before = component.render(80).map((line: string) => line.replace("›", " "));
    component.handleInput("\u001b[B");
    const after = component.render(80).map((line: string) => line.replace("›", " "));

    const describedRowBefore = before.findIndex((line: string) => line.includes("Described:"));
    const describedRowAfter = after.findIndex((line: string) => line.includes("Described:"));
    const plainRowBefore = before.findIndex((line: string) => line.includes("Plain:"));
    const plainRowAfter = after.findIndex((line: string) => line.includes("Plain:"));
    expect(describedRowBefore).toBe(describedRowAfter);
    expect(plainRowBefore).toBe(plainRowAfter);
  });

  it("filters settings by typing and keeps printable keys in the search query", () => {
    const registry = createSettingsRegistry({}, { persistPath: false });
    registry.registerSection({
      id: "x",
      title: "X",
      settings: {
        enabled: setting.boolean({ label: "Enabled", default: true, order: 1 }),
        quietMode: setting.boolean({ label: "Quiet mode", default: false, order: 2 }),
      },
    });
    const component = createPipSettingsComponent({ requestRender() {} }, { fg: (_name: string, text: string) => text }, () => undefined, registry) as any;

    component.handleInput("q");
    let rendered = component.render(80).join("\n");
    expect(rendered).toContain("Quiet mode:");
    expect(rendered).not.toContain("Enabled:");
    expect(registry.get("x.quietMode")).toBe(false);

    component.handleInput("\u007f");
    rendered = component.render(80).join("\n");
    expect(rendered).toContain("Enabled:");
    expect(rendered).toContain("Quiet mode:");
  });

  it("shows an empty search state when no settings match", () => {
    const registry = createSettingsRegistry({}, { persistPath: false });
    registry.registerSection({ id: "x", title: "X", settings: { enabled: setting.boolean({ label: "Enabled", default: true }) } });
    const component = createPipSettingsComponent({ requestRender() {} }, { fg: (_name: string, text: string) => text }, () => undefined, registry) as any;

    component.handleInput("z");
    component.handleInput("z");

    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("No matching settings");
    expect(rendered).not.toContain("Enabled:");
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

  it("reports malformed persisted settings without opening the editor", async () => {
    const registry = createSettingsRegistry({}, { persistPath: "/tmp/pip-settings.json", loadError: new Error("Cannot read malformed settings") });
    registry.registerSection({ id: "x", title: "X", settings: { enabled: setting.boolean(true) } });
    const pi = createMockPi();
    registerPipSettingsCommand(pi as any, registry);
    let opened = false;
    const ctx = createMockCtx({ custom: async () => { opened = true; } });

    await pi.commands.get("pip-settings").handler("", ctx);

    expect(opened).toBe(false);
    expect(ctx.ui.notifications.at(-1)).toMatchObject({ level: "error" });
    expect(ctx.ui.notifications.at(-1).message).toContain("Cannot read malformed settings");
  });

  it("confirms saving staged changes from the command and reports reload-required values", async () => {
    const registry = createSettingsRegistry({}, { persistPath: false });
    registry.registerSection({ id: "x", title: "X", settings: { enabled: setting.boolean({ label: "Enabled", default: true, requiresReload: true }) } });
    const pi = createMockPi();
    registerPipSettingsCommand(pi as any, registry);

    const ctx: any = {
      ui: {
        custom: async (factory: any) => {
          let result: any;
          const component = factory({ requestRender() {} }, { fg: (_name: string, text: string) => text }, undefined, (value: any) => { result = value; }) as any;
          component.handleInput("\r");
          component.handleInput("\u001b");
          return result;
        },
        select: async (_title: string, choices: string[]) => {
          expect(choices[0]).toBe("No, discard changes");
          return "Yes, save changes";
        },
        notifications: [] as any[],
        notify(message: string, level: string) { this.notifications.push({ message, level }); },
      },
    };

    await pi.commands.get("pip-settings").handler("", ctx);
    expect(registry.get("x.enabled")).toBe(false);
    expect(ctx.ui.notifications.at(-2).message).toContain("Saved");
    expect(ctx.ui.notifications.at(-1)).toEqual({ message: "Reload required to apply: X: Enabled", level: "warning" });
  });

  it("discards staged changes when save is rejected", async () => {
    const registry = createSettingsRegistry({}, { persistPath: false });
    registry.registerSection({ id: "x", title: "X", settings: { enabled: setting.boolean(true) } });
    const pi = createMockPi();
    registerPipSettingsCommand(pi as any, registry);

    const ctx: any = {
      ui: {
        custom: async (factory: any) => {
          let result: any;
          const component = factory({ requestRender() {} }, { fg: (_name: string, text: string) => text }, undefined, (value: any) => { result = value; }) as any;
          component.handleInput("\r");
          component.handleInput("\u001b");
          return result;
        },
        select: async (_title: string, choices: string[]) => {
          expect(choices[0]).toBe("No, discard changes");
          return choices[0];
        },
        notifications: [] as any[],
        notify(message: string, level: string) { this.notifications.push({ message, level }); },
      },
    };

    await pi.commands.get("pip-settings").handler("", ctx);
    expect(registry.get("x.enabled")).toBe(true);
    expect(ctx.ui.notifications.at(-1).message).toContain("Discarded");
  });
});
