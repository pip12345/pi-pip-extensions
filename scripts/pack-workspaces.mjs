import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stageRoot = mkdtempSync(join(tmpdir(), "pip-pack-"));
const commonName = "pip-common";
const commonSource = join(repoRoot, commonName);
const commonStage = join(stageRoot, commonName);

function featureNames() {
  return readdirSync(repoRoot)
    .filter((name) => name.startsWith("pi-"))
    .filter((name) => statSync(join(repoRoot, name)).isDirectory() && existsSync(join(repoRoot, name, "package.json")))
    .sort();
}

function copyPackage(source, target) {
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !path.split(/[\\/]/).includes("node_modules"),
  });
}

function typeScriptFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") files.push(...typeScriptFiles(path));
    } else if (entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function packageSpecifier(file, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const target = resolve(dirname(file), specifier);
  if (target === join(commonStage, "index.ts")) return "pip-common";
  if (target === join(commonStage, "testing.ts")) return "pip-common/testing";
  return undefined;
}

function rewriteCommonImports(featureDir) {
  for (const file of typeScriptFiles(featureDir)) {
    const source = readFileSync(file, "utf8");
    const rewritten = source.replace(/(\bfrom\s*|\bimport\s*\(\s*)(["'])([^"']+)\2/g, (match, prefix, quote, specifier) => {
      const packaged = packageSpecifier(file, specifier);
      return packaged ? `${prefix}${quote}${packaged}${quote}` : match;
    });
    if (rewritten !== source) writeFileSync(file, rewritten);
  }
}

function pack(packageDir) {
  const result = spawnSync("npm", ["pack", packageDir, "--json", ...process.argv.slice(2)], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack failed for ${relative(repoRoot, packageDir).split(sep).join("/")}`);
  return JSON.parse(result.stdout);
}

try {
  copyPackage(commonSource, commonStage);
  const stagedFeatures = featureNames().map((name) => {
    const featureStage = join(stageRoot, name);
    copyPackage(join(repoRoot, name), featureStage);
    copyPackage(commonSource, join(featureStage, "node_modules", commonName));
    rewriteCommonImports(featureStage);
    return featureStage;
  });

  const results = [];
  for (const packageDir of [commonStage, ...stagedFeatures]) results.push(...pack(packageDir));
  process.stdout.write(`${JSON.stringify(results)}\n`);
} finally {
  rmSync(stageRoot, { recursive: true, force: true });
}
