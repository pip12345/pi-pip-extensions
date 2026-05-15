import { describe, expect, it } from "vitest";
import pipCommon from "../index.ts";
import { createMockPi } from "../src/testing.ts";
import { createPipSettingsComponent, registerPipSettingsCommand } from "../src/settings-command.ts";
import { createSettingsRegistry, setting } from "../src/settings.ts";

describe("pip settings command", () => {
  it("registers /pip-settings from pip-common extension", () => {
    const pi = createMockPi();
    pipCommon(pi as any);
    expect(pi.commands.has("pip-settings")).toBe(true);
  });

  it("stages boolean and enum values until close", () => {
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
    let result: any;
    const component = createPipSettingsComponent(tui, theme, (value) => { result = value; }, registry) as any;

    expect(component.render(80).join("\n")).toContain("Enabled:");
    expect(registry.get("plan-mode.enabled")).toBe(true);

    component.handleInput("\r");
    expect(registry.get("plan-mode.enabled")).toBe(true);
    expect(component.render(80).join("\n")).toContain("unsaved");

    component.handleInput("\u001b[B");
    component.handleInput("\u001b[C");
    component.handleInput("\u001b[D");
    component.handleInput("q");

    expect(result.dirty).toBe(true);
    expect(result.values["plan-mode"].enabled).toBe(false);
    expect(result.values["plan-mode"].behavior).toBe("ask");
    expect(registry.get("plan-mode.enabled")).toBe(true);
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

  it("confirms saving staged changes from the command", async () => {
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
          component.handleInput("q");
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
    expect(ctx.ui.notifications.at(-1).message).toContain("Saved");
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
          component.handleInput("q");
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
