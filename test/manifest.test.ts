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
  it("each pi-* package declares existing extension entrypoints with default factories", async () => {
    for (const dir of packageDirs()) {
      const manifestPath = join(dir, "package.json");
      expect(existsSync(manifestPath), `${dir} has package.json`).toBe(true);

      const manifest = readJson(manifestPath);
      expect(manifest.pi?.extensions, `${manifest.name} has pi.extensions`).toBeInstanceOf(Array);
      expect(manifest.pi.extensions.length, `${manifest.name} has at least one extension`).toBeGreaterThan(0);

      for (const extensionPath of manifest.pi.extensions) {
        const absolutePath = join(dir, extensionPath);
        expect(existsSync(absolutePath), `${manifest.name} extension exists: ${extensionPath}`).toBe(true);
        const mod = await import(pathToFileURL(absolutePath).href);
        expect(typeof mod.default, `${manifest.name} default export is an extension factory`).toBe("function");
      }
    }
  });

  it("declares peer dependencies for imported pi packages", () => {
    const importsByPackage: Record<string, string[]> = {
      "pi-quiet-tools": ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
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
