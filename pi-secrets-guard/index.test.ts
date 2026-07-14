import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import secretsGuard, { bashPathTokens, isGitIgnored, resolveToolPath, __test } from "./index.ts";
import { pipSettings } from "pip-common";
import { createMockCtx, createMockPi, emitEvent } from "pip-common/testing";

function resetGuardSettings() {
  pipSettings.set("gitignore-guard.enabled", true);
  pipSettings.set("gitignore-guard.protectCommonSecrets", true);
  pipSettings.set("gitignore-guard.protectSecretignore", true);
  pipSettings.set("gitignore-guard.protectGitignore", false);
  pipSettings.set("gitignore-guard.protectReads", true);
  pipSettings.set("gitignore-guard.protectWrites", true);
  pipSettings.set("gitignore-guard.protectSearchTargets", true);
  pipSettings.set("gitignore-guard.bashGuard", "best-effort");
  pipSettings.set("gitignore-guard.promptReminder", true);
}

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pi-secrets-guard-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  return dir;
}

beforeEach(() => {
  resetGuardSettings();
});

describe("secrets guard", () => {
  it("registers compatible settings under the Secrets Guard title", () => {
    const pi = createMockPi();
    secretsGuard(pi as any);

    expect(pipSettings.section("gitignore-guard")?.title).toBe("Secrets Guard");
    expect(pipSettings.definition("gitignore-guard")?.protectGitignore.default).toBe(false);
    expect(pipSettings.definition("gitignore-guard")?.protectCommonSecrets.description).toContain(".env");
  });

  it("extracts bash argument tokens for best-effort path checks", () => {
    expect(bashPathTokens("cat secret && grep needle ignored-dir/a.txt")).toEqual(["secret", "needle", "ignored-dir/a.txt"]);
    expect(bashPathTokens("NODE_ENV=test cat secret")).toEqual(["secret"]);
    expect(bashPathTokens("node --version")).toEqual([]);
  });

  it("resolves tool paths relative to cwd and strips @ prefixes", () => {
    const cwd = resolve("/tmp/project");
    expect(resolveToolPath(cwd, "@src/file.ts")).toBe(resolve(cwd, "src/file.ts"));
    expect(resolveToolPath(cwd, "")).toBeUndefined();
  });

  it("keeps project paths root-relative and rejects outside paths", () => {
    expect(__test.pathForRoot("/repo", "/repo/guarded/file.txt")).toBe("guarded/file.txt");
    expect(__test.pathForRoot("/repo", "/other/file.txt")).toBeUndefined();
  });

  it("matches gitignore-style .secretignore rules with negation", () => {
    const rules = __test.parseIgnoreRules("# comment\nprivate/\n*.pem\n!important.pem\n");

    expect(__test.matchIgnoreRules("private/key.txt", rules)?.pattern).toBe("private/");
    expect(__test.matchIgnoreRules("nested/key.pem", rules)?.pattern).toBe("*.pem");
    expect(__test.matchIgnoreRules("important.pem", rules)).toBeUndefined();
  });

  it("blocks common secret paths by default", async () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, ".env"), "TOKEN=secret");
      writeFileSync(join(dir, ".env.example"), "TOKEN=placeholder");
      const pi = createMockPi();
      secretsGuard(pi as any);
      const ctx = createMockCtx({ cwd: dir });

      const [blocked] = await emitEvent(pi, "tool_call", { toolName: "read", input: { path: ".env" }, toolCallId: "1" }, ctx);
      expect(blocked).toMatchObject({ block: true });
      expect(blocked.reason).toContain("common-secrets");

      const [templateAllowed] = await emitEvent(pi, "tool_call", { toolName: "read", input: { path: ".env.example" }, toolCallId: "example" }, ctx);
      expect(templateAllowed).toBeUndefined();

      pipSettings.set("gitignore-guard.protectCommonSecrets", false);
      const [allowed] = await emitEvent(pi, "tool_call", { toolName: "read", input: { path: ".env" }, toolCallId: "2" }, ctx);
      expect(allowed).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks paths matched by project .secretignore", async () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, ".secretignore"), "private/\n!important.txt\n");
      mkdirSync(join(dir, "private"));
      writeFileSync(join(dir, "private", "key.txt"), "hidden");
      writeFileSync(join(dir, "important.txt"), "example");

      const pi = createMockPi();
      secretsGuard(pi as any);
      const ctx = createMockCtx({ cwd: dir });

      const [blocked] = await emitEvent(pi, "tool_call", { toolName: "read", input: { path: "private/key.txt" }, toolCallId: "1" }, ctx);
      expect(blocked).toMatchObject({ block: true });
      expect(blocked.reason).toContain(".secretignore: private/");

      const [allowed] = await emitEvent(pi, "tool_call", { toolName: "read", input: { path: "important.txt" }, toolCallId: "2" }, ctx);
      expect(allowed).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat .gitignore cache rules as secrets unless legacy protection is enabled", async () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), "cache/\n");
      mkdirSync(join(dir, "cache"));
      writeFileSync(join(dir, "cache", "data.json"), "cached");

      const pi = createMockPi();
      secretsGuard(pi as any);
      const ctx = createMockCtx({ cwd: dir });

      const [allowed] = await emitEvent(pi, "tool_call", { toolName: "read", input: { path: "cache/data.json" }, toolCallId: "1" }, ctx);
      expect(allowed).toBeUndefined();

      pipSettings.set("gitignore-guard.protectGitignore", true);
      const [blocked] = await emitEvent(pi, "tool_call", { toolName: "read", input: { path: "cache/data.json" }, toolCallId: "2" }, ctx);
      expect(blocked).toMatchObject({ block: true });
      expect(blocked.reason).toContain(".gitignore");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still exposes the legacy gitignore classifier", async () => {
    const dir = tempRepo();
    try {
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

  it("blocks bash access to guarded paths in best-effort mode", async () => {
    const dir = tempRepo();
    try {
      writeFileSync(join(dir, ".env"), "TOKEN=secret");
      const pi = createMockPi();
      secretsGuard(pi as any);
      const ctx = createMockCtx({ cwd: dir });

      const [blocked] = await emitEvent(pi, "tool_call", { toolName: "bash", input: { command: "cat .env" }, toolCallId: "1" }, ctx);
      expect(blocked).toMatchObject({ block: true });
      expect(blocked.reason).toContain("Secrets Guard");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("injects a Secrets Guard prompt reminder", async () => {
    const pi = createMockPi();
    secretsGuard(pi as any);

    const [result] = await emitEvent(pi, "before_agent_start", { systemPrompt: "base" }, createMockCtx());
    expect(result.systemPrompt).toContain("base");
    expect(result.systemPrompt).toContain("Secrets Guard is active");
    expect(result.systemPrompt).toContain("project .secretignore files");
    expect(result.systemPrompt).not.toContain("Gitignore guard");
  });
});
