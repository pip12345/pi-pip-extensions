import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCtx, createMockPi, emitEvent } from "../pip-common/testing.ts";

async function loadStats() {
  vi.resetModules();
  return (await import("./index.ts")).default;
}

function usagePath(home: string) {
  return join(home, ".pi", "agent", "pip", "usage", "token-usage.json");
}

describe("pi-stats", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pi-stats-"));
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("registers the stats command and usage event handlers", async () => {
    const stats = await loadStats();
    const pi = createMockPi();
    stats(pi as any);
    expect(pi.commands.has("stats")).toBe(true);
    expect(pi.handlers.has("message_end")).toBe(true);
  });

  it("records assistant message usage through the global rollup storage", async () => {
    const stats = await loadStats();
    const pi = createMockPi();
    stats(pi as any);

    await emitEvent(
      pi,
      "message_end",
      {
        message: {
          role: "assistant",
          timestamp: Date.UTC(2026, 5, 1, 12),
          provider: "anthropic",
          model: "claude-sonnet",
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, total: 20, cost: 0.01 },
        },
      },
      createMockCtx({ cwd: "/workspace" })
    );

    const saved = JSON.parse(readFileSync(usagePath(home), "utf8"));
    expect(saved.buckets["2026-06-01|anthropic|claude-sonnet"]).toMatchObject({
      turns: 1,
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 3,
      cache: 5,
      total: 20,
      cost: 0.01,
    });
  });
});
