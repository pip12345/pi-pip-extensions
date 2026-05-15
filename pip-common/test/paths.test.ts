import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipDir, pipPath } from "../src/paths.ts";

describe("pip paths", () => {
  it("keeps pip-owned state under ~/.pi/agent/pip", () => {
    expect(pipDir()).toBe(join(homedir(), ".pi", "agent", "pip"));
    expect(pipPath("backup", "undo-redo")).toBe(join(homedir(), ".pi", "agent", "pip", "backup", "undo-redo"));
  });
});
