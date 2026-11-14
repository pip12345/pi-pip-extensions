import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, ExtensionRunner, SessionManager, initTheme, type ExtensionFactory, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsRegistry, resetPipToolsForTests, setPipSettingsRegistryForTests } from "../pip-common/index.ts";
import toolUi from "./index.ts";

const roots: string[] = [];
afterEach(() => {
  resetPipToolsForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function load(enabled = true, editDiff = true, before: ExtensionFactory[] = [], delegate = false) {
  const root = mkdtempSync(join(tmpdir(), "tool-ui-renderers-"));
  roots.push(root);
  const downstream: ToolRenderers = { renderShell: "default", renderCall: () => new Text("downstream", 0, 0) };
  const downstreamResolver = vi.fn((_name: string, next: () => ToolRenderers | undefined) => delegate ? next() : downstream);
  const settings = createSettingsRegistry({ "tool-ui": { enabled, editDiff } }, { persistPath: false });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      ...before,
      (pi) => {
        setPipSettingsRegistryForTests(pi, settings);
        toolUi(pi);
      },
      (pi) => pi.registerToolRenderer(downstreamResolver),
    ],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  expect(loaded.errors).toEqual([]);
  // Renderer resolution does not access a model registry or bind a session's execution actions.
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, SessionManager.inMemory(root), undefined as any);
  return { runner, settings, downstream, downstreamResolver };
}

describe("Tool UI with Pi's public renderer resolver chain", () => {
  it("registers no tools and overrides only the targeted display slots", async () => {
    initTheme("dark", false);
    const { runner, downstream, downstreamResolver } = await load();
    const base = vi.fn(() => undefined);
    expect(runner.getAllRegisteredTools()).toEqual([]);
    for (const name of ["read", "grep", "find", "ls", "edit"]) {
      const renderer = runner.resolveToolRenderers(name, base)!;
      expect(renderer.renderShell).toBe("self");
      expect(renderer.renderCall).toBeTypeOf("function");
      expect(renderer.renderResult).toBeTypeOf("function");
    }
    expect(downstreamResolver).not.toHaveBeenCalled();
    expect(base).not.toHaveBeenCalled();
    for (const name of ["bash", "write", "subagent", "mcp__server__tool"]) {
      expect(runner.resolveToolRenderers(name, base)).toBe(downstream);
    }
  });

  it("delegates disabled adapters to the next resolver without changing its object", async () => {
    const { runner, settings, downstream } = await load(false);
    for (const name of ["read", "grep", "find", "ls", "edit"]) {
      expect(runner.resolveToolRenderers(name, () => undefined)).toBe(downstream);
    }
    settings.set("tool-ui.enabled", true);
    settings.set("tool-ui.editDiff", false);
    expect(runner.resolveToolRenderers("edit", () => undefined)).toBe(downstream);
    expect(runner.resolveToolRenderers("read", () => undefined)?.renderShell).toBe("self");
    settings.set("tool-ui.editDiff", true);
    expect(runner.resolveToolRenderers("edit", () => undefined)?.renderShell).toBe("self");
  });

  it("preserves load order and reaches the base when later resolvers delegate", async () => {
    const earlier: ToolRenderers = { renderShell: "default" };
    const { runner } = await load(true, true, [(pi) => pi.registerToolRenderer((name, next) => name === "read" ? earlier : next())]);
    expect(runner.resolveToolRenderers("read", () => undefined)).toBe(earlier);
    expect(runner.resolveToolRenderers("edit", () => undefined)?.renderShell).toBe("self");

    const base: ToolRenderers = { renderShell: "default" };
    const { runner: fallbackRunner } = await load(false, false, [], true);
    expect(fallbackRunner.resolveToolRenderers("read", () => base)).toBe(base);
    expect(fallbackRunner.resolveToolRenderers("unknown", () => undefined)).toBeUndefined();
  });
});
