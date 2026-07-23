import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function packageDirs() {
  return readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-"))
    .map((entry) => join(repoRoot, entry.name));
}

describe("pi package manifests", () => {
  it("top-level git package manifest is npm-compatible and lists literal extension entrypoints", () => {
    const manifest = readJson(join(repoRoot, "package.json"));
    const extensionPaths = manifest.pi?.extensions ?? [];
    const expectedPiExtensions = packageDirs().map((dir) => `${dir.slice(repoRoot.length + 1)}/index.ts`).sort();

    expect(manifest.name).toBe("pi-pip-extensions");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(extensionPaths).toEqual(["pip-common/index.ts", ...expectedPiExtensions]);
    for (const extensionPath of extensionPaths) {
      expect(extensionPath).not.toMatch(/[?*]/);
      expect(existsSync(join(repoRoot, extensionPath)), `top-level extension exists: ${extensionPath}`).toBe(true);
    }
  });

  it("each feature package declares its bundled common bootstrap and source entrypoint", async () => {
    for (const dir of packageDirs()) {
      const manifestPath = join(dir, "package.json");
      expect(existsSync(manifestPath), `${dir} has package.json`).toBe(true);

      const manifest = readJson(manifestPath);
      expect(manifest.pi?.extensions, `${manifest.name} loads common before its feature`).toEqual([
        "node_modules/pip-common/index.ts",
        "./index.ts",
      ]);
      expect(manifest.dependencies?.["pip-common"], `${manifest.name} depends on common`).toBe("0.1.0");
      expect(manifest.bundledDependencies, `${manifest.name} bundles common`).toContain("pip-common");

      const sourceEntrypoint = join(dir, "index.ts");
      expect(existsSync(sourceEntrypoint), `${manifest.name} source entrypoint exists`).toBe(true);
      const mod = await import(pathToFileURL(sourceEntrypoint).href);
      expect(typeof mod.default, `${manifest.name} default export is an extension factory`).toBe("function");
    }
  });

  it("declares peer dependencies for imported pi packages", () => {
    const importsByPackage: Record<string, string[]> = {
      "pi-tool-ui": ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
      "pi-stats": ["@earendil-works/pi-tui"],
      "pi-tree-edit": ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
    };

    for (const dir of packageDirs()) {
      const manifest = readJson(join(dir, "package.json"));
      for (const dependency of importsByPackage[manifest.name] ?? []) {
        expect(manifest.peerDependencies?.[dependency], `${manifest.name} declares peer ${dependency}`).toBe("*");
      }
    }
  });
});
