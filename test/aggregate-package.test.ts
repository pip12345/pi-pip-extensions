import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const repoRoot = resolve(import.meta.dirname, "..");

describe("aggregate package", () => {
  it("loads directly from a clean source checkout", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pip-aggregate-test-"));
    const packageRoot = join(tempRoot, "package");
    const projectRoot = join(tempRoot, "project");
    const agentRoot = join(tempRoot, "agent");

    try {
      mkdirSync(packageRoot, { recursive: true });
      mkdirSync(projectRoot, { recursive: true });
      mkdirSync(agentRoot, { recursive: true });

      const featureDirs = readdirSync(repoRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-"))
        .map((entry) => entry.name);
      for (const name of ["package.json", "pip-common", ...featureDirs]) {
        cpSync(join(repoRoot, name), join(packageRoot, name), {
          recursive: true,
          filter: (source) => !source.split(/[\\/]/).includes("node_modules"),
        });
      }

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

      expect(loader.getExtensions().errors).toEqual([]);
      expect(existsSync(join(packageRoot, "node_modules"))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
