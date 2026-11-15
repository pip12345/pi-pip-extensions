import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyUsage } from "../pip-common/index.ts";
import { RealRunner } from "./src/runner.ts";
import type { ChildAgentRuntime, ChildAgentRuntimeSession } from "./src/child-runtime.ts";
import type { LaunchInput, SubagentRun } from "./src/types.ts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runTool(durationMs: number | undefined) {
  const root = mkdtempSync(join(tmpdir(), "pip-native-duration-"));
  roots.push(root);
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  let subscriber: ((event: any) => void) | undefined;
  const session = {
    sessionFile: join(root, "child.jsonl"),
    subscribe(callback: typeof subscriber) { subscriber = callback; return () => { subscriber = undefined; }; },
    async prompt() {
      subscriber?.({ type: "tool_execution_start", toolCallId: "call", toolName: "read", args: { path: "fixture.txt" } });
      subscriber?.({ type: "tool_execution_end", toolCallId: "call", toolName: "read", durationMs, isError: durationMs === undefined, result: { content: [{ type: "text", text: "fixture result" }] } });
    },
    getActiveToolNames: () => ["read"],
    setActiveToolsByName() {},
    dispose() {},
  };
  const runtime: ChildAgentRuntime = { async create() { return { session, modelRuntime: {} } as unknown as ChildAgentRuntimeSession; } };
  const input: LaunchInput = {
    agent: { name: "fixture", description: "fixture", source: "builtin", filePath: "fixture.md", tools: "all", systemPrompt: "" },
    prompt: "fixture", cwd: root, parentSessionKey: "fixture", keep: false, background: false,
  };
  const run: SubagentRun = {
    id: "fixture", agent: "fixture", prompt: "fixture", cwd: root, parentSessionKey: "fixture", keep: false,
    background: false, detached: false, status: "running", createdAt: 1, updatedAt: 1,
    usage: emptyUsage(), events: [], abortController: new AbortController(),
  };
  await new RealRunner(runtime).launch(input, run);
  await run.dispose?.();
  return run.events;
}

describe("native subagent tool duration", () => {
  it.each([17.25, 0])("preserves Pi's recorded execution duration %s", async (durationMs) => {
    const events = await runTool(durationMs);
    expect(events.find((event) => event.type === "tool_start")).toMatchObject({ id: "call", name: "read", argsSummary: "fixture.txt", at: expect.any(Number) });
    expect(events.find((event) => event.type === "tool_end")).toMatchObject({ id: "call", ok: true, resultSummary: "fixture result", durationMs, at: expect.any(Number) });
  });

  it("leaves duration unknown when Pi reports no execution duration", async () => {
    const events = await runTool(undefined);
    expect(events.find((event) => event.type === "tool_end")).toMatchObject({ id: "call", ok: false, durationMs: undefined });
  });
});
