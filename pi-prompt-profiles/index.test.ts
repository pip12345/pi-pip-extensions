import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import promptProfiles, { __test } from "./index.ts";
import { createMockPi } from "../pip-common/testing.ts";
import { getPipSettingsRegistry } from "../pip-common/index.ts";

describe("pi-prompt-profiles", () => {
  it("registers prompt settings and before_agent_start hook", () => {
    const pi = createMockPi();
    promptProfiles(pi as any);
    expect(pi.handlers.has("before_agent_start")).toBe(true);
    const settings = getPipSettingsRegistry(pi);
    expect(settings.section(__test.SETTINGS_ID)?.title).toBe("Prompt Profiles");
    expect(settings.definition(__test.SETTINGS_ID)?.enabled.default).toBe(true);
    expect(settings.definition(__test.SETTINGS_ID)?.profile.default).toBe("default.md");
    expect(settings.definition(__test.SETTINGS_ID)?.mode.default).toBe("append");
  });

  it("discovers markdown profiles from a prompt directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-prompt-profiles-"));
    writeFileSync(join(dir, "alpha.md"), "alpha prompt");
    writeFileSync(join(dir, "ignored.txt"), "ignored");

    const profiles = __test.discoverProfiles(dir);
    expect(profiles.map((profile) => profile.id)).toEqual(["alpha.md"]);
    expect(profiles[0]?.source).toBe("bundled");
  });

  it("merges user profiles over bundled profiles by filename", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-prompt-profiles-"));
    const bundledDir = join(root, "bundled");
    const userDir = join(root, "user");
    mkdirSync(bundledDir);
    mkdirSync(userDir);
    writeFileSync(join(bundledDir, "default.md"), "bundled default");
    writeFileSync(join(userDir, "custom.md"), "custom prompt");
    writeFileSync(join(userDir, "default.md"), "user default");

    const profiles = __test.discoverAvailableProfiles(bundledDir, userDir);
    expect(profiles.map((profile) => profile.id)).toEqual(["custom.md", "default.md"]);
    expect(profiles.find((profile) => profile.id === "default.md")?.source).toBe("user");
    expect(__test.readSelectedProfile("default.md", [userDir, bundledDir])).toBe("user default");
  });

  it("applies selected profile according to mode", () => {
    expect(__test.applyPromptProfile("base", "extra", "append")).toBe("base\n\nextra");
    expect(__test.applyPromptProfile("base", "extra", "prepend")).toBe("extra\n\nbase");
    expect(__test.applyPromptProfile("base", "extra", "replace")).toBe("extra");
  });

  it("reads a selected profile from a prompt directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-prompt-profiles-"));
    writeFileSync(join(dir, "alpha.md"), "alpha prompt\n");

    expect(__test.readSelectedProfile("alpha.md", dir)).toBe("alpha prompt");
    expect(__test.readSelectedProfile("../alpha.md", dir)).toBeUndefined();
  });
});
