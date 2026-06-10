import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bashPathTokens, isGitIgnored, resolveToolPath, __test } from "./index.ts";

describe("gitignore guard", () => {
  it("extracts only path-like bash tokens", () => {
    expect(bashPathTokens("cat secret && grep needle ignored-dir/a.txt")).toEqual(["secret", "needle", "ignored-dir/a.txt"]);
    expect(bashPathTokens("NODE_ENV=test cat secret")).toEqual(["secret"]);
    expect(bashPathTokens("node --version")).toEqual([]);
  });

  it("resolves tool paths relative to cwd and strips @ prefixes", () => {
    const cwd = resolve("/tmp/project");
    expect(resolveToolPath(cwd, "@src/file.ts")).toBe(resolve(cwd, "src/file.ts"));
    expect(resolveToolPath(cwd, "")).toBeUndefined();
  });

  it("keeps git paths repo-relative and rejects outside paths", () => {
    expect(__test.pathForGit("/repo", "/repo/ignored/file.txt")).toBe("ignored/file.txt");
    expect(__test.pathForGit("/repo", "/other/file.txt")).toBeUndefined();
  });

  it("delegates ignored-path classification to git check-ignore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-gitignore-guard-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: dir });
      writeFileSync(join(dir, ".gitignore"), "secret.txt\nignored-dir/\n*.log\n");
      mkdirSync(join(dir, "ignored-dir"));
      writeFileSync(join(dir, "secret.txt"), "hidden");
      writeFileSync(join(dir, "visible.txt"), "shown");

      await expect(isGitIgnored(dir, join(dir, "secret.txt"))).resolves.toBe(true);
      await expect(isGitIgnored(dir, join(dir, "ignored-dir", "new.txt"))).resolves.toBe(true);
      await expect(isGitIgnored(dir, join(dir, "generated.log"))).resolves.toBe(true);
      await expect(isGitIgnored(dir, join(dir, "visible.txt"))).resolves.toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
