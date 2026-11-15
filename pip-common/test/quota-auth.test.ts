import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClaudeCodeCredentials } from "../src/quota/auth.ts";

let root: string;
let configDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-quota-auth-"));
  configDir = join(root, ".claude");
  mkdirSync(configDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function save(data: unknown, directory = configDir): void {
  writeFileSync(join(directory, ".credentials.json"), JSON.stringify(data));
}

describe("Claude Code quota credentials", () => {
  it("reads only the access token from the default Claude Code auth file", () => {
    vi.stubEnv("HOME", root);
    expect(homedir()).toBe(root);
    save({ claudeAiOauth: { accessToken: "native-token", refreshToken: "refresh-token", subscriptionType: "max" } });
    expect(getClaudeCodeCredentials({})).toEqual({ token: "native-token" });
  });

  it("honors CLAUDE_CONFIG_DIR without using the default login", () => {
    vi.stubEnv("HOME", root);
    save({ claudeAiOauth: { accessToken: "default-token" } });
    const custom = join(root, "custom");
    mkdirSync(custom);
    const env = { CLAUDE_CONFIG_DIR: custom };
    expect(getClaudeCodeCredentials(env)).toBeUndefined();
    save({ claudeAiOauth: { accessToken: "custom-token" } }, custom);
    expect(getClaudeCodeCredentials(env)).toEqual({ token: "custom-token" });
  });

  it("rereads rotated credentials and notices logout", () => {
    const env = { CLAUDE_CONFIG_DIR: configDir };
    save({ claudeAiOauth: { accessToken: "first-token" } });
    expect(getClaudeCodeCredentials(env)).toEqual({ token: "first-token" });
    save({ claudeAiOauth: { accessToken: "second-token" } });
    expect(getClaudeCodeCredentials(env)).toEqual({ token: "second-token" });
    unlinkSync(join(configDir, ".credentials.json"));
    expect(getClaudeCodeCredentials(env)).toBeUndefined();
  });

  it.each([null, {}, { apiKey: "api-key" }, { claudeAiOauth: null }, { claudeAiOauth: { accessToken: 123 } }, { claudeAiOauth: { accessToken: "   " } }])(
    "rejects files without a nonempty OAuth access token: %j",
    (data) => {
      save(data);
      expect(getClaudeCodeCredentials({ CLAUDE_CONFIG_DIR: configDir })).toBeUndefined();
    },
  );

  it("treats malformed or unreadable credential files as unavailable", () => {
    const path = join(configDir, ".credentials.json");
    writeFileSync(path, "invalid json");
    expect(getClaudeCodeCredentials({ CLAUDE_CONFIG_DIR: configDir })).toBeUndefined();
    unlinkSync(path);
    mkdirSync(path);
    expect(getClaudeCodeCredentials({ CLAUDE_CONFIG_DIR: configDir })).toBeUndefined();
  });
});
