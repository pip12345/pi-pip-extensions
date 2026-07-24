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
let installsRoot: string;
let combinedInstallDir: string;
let featurePacks: PackResult[];

const EXPECTED_STANDALONE_TOOLS: Record<string, string[]> = {
  "pi-question": ["question"],
  "pi-subagents": ["subagent"],
  "pi-tiny-mcp": ["tiny-mcp"],
  "pi-todo": ["todo_read", "todo_update", "todo_write"],
  "pi-tool-ui": ["edit", "find", "grep", "ls", "read"],
};

function readPackageName(dir: string): string {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
}

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "pip-package-test-"));
  sourceRoot = join(tempRoot, "source");
  packDir = join(tempRoot, "packs");
  installsRoot = join(tempRoot, "installs");
  combinedInstallDir = join(installsRoot, "combined");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installsRoot, { recursive: true });

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

  const install = (dir: string, packs: PackResult[]) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"private":true,"type":"module"}\n');
    execFileSync("npm", [
      "install",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      ...packs.map((pack) => join(packDir, pack.filename)),
    ], { cwd: dir, stdio: "pipe" });
  };
  for (const pack of featurePacks) install(join(installsRoot, pack.name), [pack]);
  install(combinedInstallDir, featurePacks.filter((pack) => pack.name === "pi-context" || pack.name === "pi-todo"));
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
      const packageRoot = join(installsRoot, pack.name, "node_modules", pack.name);
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
      const featureExtension = result.extensions[1];
      if (EXPECTED_STANDALONE_TOOLS[pack.name]) {
        expect([...featureExtension.tools.keys()].sort(), `${pack.name} registers tools without sibling features`).toEqual(EXPECTED_STANDALONE_TOOLS[pack.name]);
      }
      if (pack.name === "pi-stats") expect(featureExtension.commands.has("stats"), "Stats loads without Subagents").toBe(true);
    }
  }, 120_000);

  it("bootstraps common once when multiple standalone features load together", async () => {
    const packageRoots = ["pi-context", "pi-todo"].map((name) => join(combinedInstallDir, "node_modules", name));
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
