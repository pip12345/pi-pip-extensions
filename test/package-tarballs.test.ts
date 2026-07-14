import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

interface PackResult {
  name: string;
  filename: string;
  files: Array<{ path: string }>;
}

const repoRoot = resolve(import.meta.dirname, "..");
let tempRoot: string;
let sourceRoot: string;
let packDir: string;
let installDir: string;
let featurePacks: PackResult[];

function readPackageName(dir: string): string {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
}

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "pip-package-test-"));
  sourceRoot = join(tempRoot, "source");
  packDir = join(tempRoot, "packs");
  installDir = join(tempRoot, "install");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, "package.json"), '{"private":true,"type":"module"}\n');

  const featureDirs = readdirSync(repoRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-")).map((entry) => entry.name);
  for (const name of ["package.json", "package-lock.json", "pip-common", "scripts", ...featureDirs]) {
    cpSync(join(repoRoot, name), join(sourceRoot, name), { recursive: true, filter: (source) => !source.split(/[\\/]/).includes("node_modules") });
  }

  const output = execFileSync(process.execPath, [join(sourceRoot, "scripts", "pack-workspaces.mjs"), "--pack-destination", packDir], {
    cwd: sourceRoot,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  const packs = JSON.parse(output) as PackResult[];
  featurePacks = packs.filter((pack) => pack.name !== "pip-common");

  execFileSync("npm", [
    "install",
    "--ignore-scripts",
    "--legacy-peer-deps",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
    ...featurePacks.map((pack) => join(packDir, pack.filename)),
  ], { cwd: installDir, stdio: "pipe" });
}, 120_000);

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("standalone package tarballs", () => {
  it("bundle pip-common and contain only runtime TypeScript", () => {
    expect(featurePacks).toHaveLength(15);
    for (const pack of featurePacks) {
      expect(pack.files.some((file) => file.path === "node_modules/pip-common/index.ts"), `${pack.name} bundles common`).toBe(true);
      expect(pack.files.some((file) => file.path.endsWith(".test.ts")), `${pack.name} excludes tests`).toBe(false);
    }
  });

  it("install and load through Pi package rules", async () => {
    for (const pack of featurePacks) {
      const packageRoot = join(installDir, "node_modules", pack.name);
      expect(readPackageName(packageRoot)).toBe(pack.name);

      const projectRoot = join(tempRoot, "projects", pack.name);
      const agentRoot = join(tempRoot, "agents", pack.name);
      mkdirSync(projectRoot, { recursive: true });
      mkdirSync(agentRoot, { recursive: true });
      const loader = new DefaultResourceLoader({
        cwd: projectRoot,
        agentDir: agentRoot,
        additionalExtensionPaths: [packageRoot],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      const result = loader.getExtensions();
      expect(result.errors, `${pack.name} has no load errors`).toEqual([]);
      expect(result.extensions.map((extension) => extension.path), `${pack.name} loads common before its feature`).toEqual([
        join(packageRoot, "node_modules", "pip-common", "index.ts"),
        join(packageRoot, "index.ts"),
      ]);
    }
  }, 120_000);

  it("bootstraps common once when multiple standalone features load together", async () => {
    const packageRoots = ["pi-context", "pi-todo"].map((name) => join(installDir, "node_modules", name));
    const projectRoot = join(tempRoot, "projects", "combined");
    const agentRoot = join(tempRoot, "agents", "combined");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(agentRoot, { recursive: true });
    const loader = new DefaultResourceLoader({
      cwd: projectRoot,
      agentDir: agentRoot,
      additionalExtensionPaths: packageRoots,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    expect(result.errors).toEqual([]);
    const commonExtensions = result.extensions.filter((extension) => extension.path.includes("node_modules/pip-common/index.ts"));
    expect(commonExtensions).toHaveLength(2);
    const sharedContext = {};
    for (const extension of commonExtensions) {
      for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, sharedContext as any);
    }
    expect(commonExtensions.filter((extension) => extension.commands.has("pip-settings"))).toHaveLength(1);
  }, 120_000);
});
