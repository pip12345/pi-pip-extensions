import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadStorage() {
  vi.resetModules();
  return await import("./storage.ts");
}

function usagePath(home: string) {
  return join(home, ".pi", "agent", "pip", "usage", "token-usage.json");
}

function eventDayDir(home: string, day: string) {
  return join(home, ".pi", "agent", "pip", "usage", "events", day);
}

function dailyPath(home: string, day: string) {
  return join(home, ".pi", "agent", "pip", "usage", "daily", `${day}.json`);
}

describe("pi-stats usage storage", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pi-stats-storage-"));
    vi.stubEnv("HOME", home);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 1, 12)));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("appends usage events to a per-session daily JSONL file", async () => {
    const { readRollups, updateRollups } = await loadStorage();

    updateRollups({
      ts: Date.UTC(2026, 5, 1, 12),
      sessionFile: "/tmp/session-a.json",
      provider: "anthropic",
      model: "claude-sonnet",
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 3,
      cache: 5,
      total: 20,
      cost: 0.01,
    });

    expect(existsSync(usagePath(home))).toBe(false);
    const files = readdirSync(eventDayDir(home, "2026-06-01"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.jsonl$/);
    const lines = readFileSync(join(eventDayDir(home, "2026-06-01"), files[0]), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const saved = readRollups();
    expect(saved.buckets["2026-06-01|anthropic|claude-sonnet"]).toMatchObject({
      day: "2026-06-01",
      provider: "anthropic",
      model: "claude-sonnet",
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

  it("dedupes persisted event ids and ignores malformed events during aggregation", async () => {
    const { readRollups, updateRollups } = await loadStorage();
    const event = {
      id: "same-event",
      ts: Date.UTC(2026, 5, 1, 12),
      sessionFile: "/tmp/session-a.json",
      provider: "anthropic",
      model: "claude-sonnet",
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 3,
      cache: 5,
      total: 20,
      cost: 0.01,
    };

    updateRollups(event);
    updateRollups(event);
    const files = readdirSync(eventDayDir(home, "2026-06-01"));
    writeFileSync(
      join(eventDayDir(home, "2026-06-01"), files[0]),
      [
        JSON.stringify({ ts: Date.UTC(2026, 5, 1, 13), provider: "anthropic", model: "bad-string", input: "10", output: 1, total: 11 }),
        JSON.stringify({ ts: Date.UTC(2026, 5, 1, 13), provider: "anthropic", model: "bad-negative", input: -1, output: 1, total: 0 }),
        JSON.stringify({ ts: Date.UTC(2026, 5, 1, 13), provider: "anthropic", model: "bad-zero", input: 0, output: 0, total: 0 }),
      ].join("\n") + "\n",
      { flag: "a" }
    );

    const saved = readRollups();
    expect(saved.buckets["2026-06-01|anthropic|claude-sonnet"]).toMatchObject({ turns: 1, total: 20 });
    expect(saved.buckets["2026-06-01|anthropic|bad-string"]).toBeUndefined();
    expect(saved.buckets["2026-06-01|anthropic|bad-negative"]).toBeUndefined();
    expect(saved.buckets["2026-06-01|anthropic|bad-zero"]).toBeUndefined();
  });

  it("ignores malformed daily rollup buckets", async () => {
    mkdirSync(join(home, ".pi", "agent", "pip", "usage", "daily"), { recursive: true });
    writeFileSync(
      dailyPath(home, "2026-06-01"),
      JSON.stringify(
        {
          version: 1,
          updatedAt: Date.UTC(2026, 5, 1),
          buckets: {
            "2026-06-01|anthropic|bad": {
              day: "2026-06-01",
              provider: "anthropic",
              model: "bad",
              turns: 1,
              input: "10",
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              cache: 0,
              total: 15,
              cost: 0,
              firstTs: Date.UTC(2026, 5, 1, 12),
              lastTs: Date.UTC(2026, 5, 1, 12),
            },
            "2026-06-01|anthropic|good": {
              day: "2026-06-01",
              provider: "anthropic",
              model: "good",
              turns: 1,
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              cache: 0,
              total: 15,
              cost: 0,
              firstTs: Date.UTC(2026, 5, 1, 12),
              lastTs: Date.UTC(2026, 5, 1, 12),
            },
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const { readRollups } = await loadStorage();
    const saved = readRollups();
    expect(saved.buckets["2026-06-01|anthropic|bad"]).toBeUndefined();
    expect(saved.buckets["2026-06-01|anthropic|good"]).toMatchObject({ turns: 1, total: 15 });
  });

  it("compacts past event days into daily summaries", async () => {
    const { readRollups, updateRollups } = await loadStorage();

    updateRollups({
      ts: Date.UTC(2026, 5, 1, 12),
      sessionFile: "/tmp/session-a.json",
      provider: "anthropic",
      model: "claude-sonnet",
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 3,
      cache: 5,
      total: 20,
      cost: 0.01,
    });

    vi.setSystemTime(new Date(Date.UTC(2026, 5, 2, 1)));
    const saved = readRollups();

    expect(existsSync(dailyPath(home, "2026-06-01"))).toBe(true);
    expect(existsSync(eventDayDir(home, "2026-06-01"))).toBe(false);
    expect(saved.buckets["2026-06-01|anthropic|claude-sonnet"]).toMatchObject({ turns: 1, total: 20 });
  });

  it("recovers claimed compaction directories immediately without hiding or double-counting events", async () => {
    const claimed = join(home, ".pi", "agent", "pip", "usage", "events", `2026-06-01.compacting.123.${Date.UTC(2026, 5, 2)}`);
    mkdirSync(claimed, { recursive: true });
    writeFileSync(
      join(claimed, "session.jsonl"),
      JSON.stringify({ id: "claimed-event", ts: Date.UTC(2026, 5, 1, 12), provider: "anthropic", model: "claude-sonnet", input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cache: 0, total: 15, cost: 0.01 }) + "\n",
      "utf8"
    );

    const { readRollups } = await loadStorage();
    const saved = readRollups();
    const savedAgain = readRollups();

    expect(existsSync(claimed)).toBe(false);
    expect(saved.buckets["2026-06-01|anthropic|claude-sonnet"]).toMatchObject({ turns: 1, total: 15 });
    expect(savedAgain.buckets["2026-06-01|anthropic|claude-sonnet"]).toMatchObject({ turns: 1, total: 15 });
  });
});
