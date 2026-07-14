import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commonSource = join(repoRoot, "pip-common");

function featureDirectories() {
  return readdirSync(repoRoot)
    .filter((name) => name.startsWith("pi-"))
    .map((name) => join(repoRoot, name))
    .filter((path) => statSync(path).isDirectory() && existsSync(join(path, "package.json")));
}

const staged = [];
try {
  for (const featureDir of featureDirectories()) {
    const nodeModulesDir = join(featureDir, "node_modules");
    const target = join(nodeModulesDir, "pip-common");
    if (existsSync(target)) continue;
    cpSync(commonSource, target, {
      recursive: true,
      filter: (source) => !source.split(/[\\/]/).includes("node_modules") && !source.split(/[\\/]/).includes("test"),
    });
    staged.push({ nodeModulesDir, target });
  }

  const result = spawnSync("npm", ["pack", "--json", "--workspaces", ...process.argv.slice(2)], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  for (const { nodeModulesDir, target } of staged) {
    rmSync(target, { recursive: true, force: true });
    try {
      if (readdirSync(nodeModulesDir).length === 0) rmSync(nodeModulesDir, { recursive: true, force: true });
    } catch {}
  }
}
