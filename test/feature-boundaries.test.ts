import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const featureNames = readdirSync(repoRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-"))
  .map((entry) => entry.name)
  .sort();
const featureSet = new Set(featureNames);

function productionTypeScriptFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...productionTypeScriptFiles(path));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

function moduleSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) specs.push(match[1]);
  return specs;
}

function topLevelDirectory(path: string): string | undefined {
  const rel = relative(repoRoot, path);
  if (rel.startsWith("..") || rel === "") return undefined;
  return rel.split(sep)[0];
}

function siblingFeature(specifier: string, importer: string, owner: string): string | undefined {
  if (featureSet.has(specifier) && specifier !== owner) return specifier;
  if (!specifier.startsWith(".")) return undefined;
  const resolved = resolve(dirname(importer), specifier);
  const targetOwner = topLevelDirectory(resolved);
  return targetOwner && featureSet.has(targetOwner) && targetOwner !== owner ? targetOwner : undefined;
}

describe("feature module boundaries", () => {
  it("prevents production imports between sibling features", () => {
    const violations: string[] = [];
    for (const feature of featureNames) {
      for (const file of productionTypeScriptFiles(resolve(repoRoot, feature))) {
        for (const specifier of moduleSpecifiers(readFileSync(file, "utf8"))) {
          const sibling = siblingFeature(specifier, file, feature);
          if (sibling) violations.push(`${relative(repoRoot, file)} imports ${sibling} via ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("prevents pip-common from depending on feature modules", () => {
    const violations: string[] = [];
    for (const file of productionTypeScriptFiles(resolve(repoRoot, "pip-common"))) {
      for (const specifier of moduleSpecifiers(readFileSync(file, "utf8"))) {
        if (featureSet.has(specifier)) violations.push(`${relative(repoRoot, file)} imports ${specifier}`);
        if (specifier.startsWith(".")) {
          const targetOwner = topLevelDirectory(resolve(dirname(file), specifier));
          if (targetOwner && featureSet.has(targetOwner)) violations.push(`${relative(repoRoot, file)} imports ${targetOwner} via ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("uses the packaged pip-common entrypoint instead of source-relative imports", () => {
    const violations: string[] = [];
    for (const feature of featureNames) {
      for (const file of productionTypeScriptFiles(resolve(repoRoot, feature))) {
        for (const specifier of moduleSpecifiers(readFileSync(file, "utf8"))) {
          if (specifier.includes("pip-common") && specifier !== "pip-common" && specifier !== "pip-common/testing") {
            violations.push(`${relative(repoRoot, file)} imports ${specifier}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
