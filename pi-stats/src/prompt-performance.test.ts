import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCtx, createMockPi, emitEvent } from "../../pip-common/testing.ts";
import { renderRegisteredFooterItems, type PipFooterRegion } from "../../pip-common/index.ts";
import { formatPromptPerformance, promptPerformanceById, registerPromptPerformance, PROMPT_PERFORMANCE_ENTRY, type PromptPerformance } from "./prompt-performance.ts";

function assistant(output = 100, stopReason = "stop") {
  return {
    role: "assistant", content: [{ type: "text", text: "Done" }],
    api: "openai-responses", provider: "openai", model: "gpt",
    usage: { input: 10, output, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}

function setup(mode = "tui", session = SessionManager.inMemory()) {
  const pi = createMockPi();
  registerPromptPerformance(pi as any);
  const ctx = createMockCtx({ sessionManager: session });
  ctx.mode = mode;
  pi.appendEntry = (customType, data) => {
    pi.entries.push({ customType, data });
    session.appendCustomEntry(customType, data);
  };
  return { pi, ctx, session };
}

type Setup = ReturnType<typeof setup>;

function shown({ pi, ctx }: Setup, region: PipFooterRegion = "tokens"): string {
  return renderRegisteredFooterItems(pi, { ctx, theme: { fg: (_color: string, text: string) => text }, width: 120, region }).join(" ");
}

async function userPrompt({ pi, ctx, session }: Setup, text = "Do work", startRequest = true) {
  await emitEvent(pi, "turn_start", {}, ctx);
  const message = { role: "user" as const, content: text, timestamp: Date.now() };
  await emitEvent(pi, "message_start", { message }, ctx);
  await emitEvent(pi, "message_end", { message }, ctx);
  const id = session.appendMessage(message);
  if (startRequest) await emitEvent(pi, "context", {}, ctx);
  return id;
}

async function response({ pi, ctx, session }: Setup, output = 100, stopReason = "stop") {
  const message = assistant(output, stopReason);
  await emitEvent(pi, "message_end", { message }, ctx);
  session.appendMessage(message as any);
  await emitEvent(pi, "turn_end", { message, entries: [] }, ctx);
}

const sample: PromptPerformance = { promptEntryId: "u1", durationMs: 15_000, generationMs: 5000, outputTokens: 300, outcome: "completed" };

describe("prompt performance", () => {
  let now: number;

  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  afterEach(() => vi.restoreAllMocks());

  it("publishes once at settlement with total elapsed time and generation-only speed", async () => {
    const state = setup();
    const { pi, ctx } = state;
    const promptEntryId = await userPrompt(state);
    now = 2000;
    await response(state, 100, "toolUse");
    now = 12_000;
    await emitEvent(pi, "message_end", { message: { role: "toolResult", usage: { output: 9000 } } }, ctx);
    expect(pi.entries).toEqual([]);
    expect(shown(state)).toBe("");

    await emitEvent(pi, "context", {}, ctx);
    now = 15_000;
    await response(state, 200);
    await emitEvent(pi, "agent_end", {}, ctx);
    expect(pi.entries).toEqual([]);
    expect(shown(state)).toBe("");
    await emitEvent(pi, "agent_settled", { aborted: false }, ctx);
    expect(pi.entries).toEqual([{ customType: PROMPT_PERFORMANCE_ENTRY, data: { ...sample, promptEntryId } }]);
    expect(shown(state)).toBe("15.0s · 60 t/s");
    expect(shown(state, "right")).toBe("");
    expect(shown(state, "below")).toBe("");
    expect(ctx.ui.statuses.size).toBe(0);
    expect(pi.messages).toEqual([]);
    expect(pi.markdownTransformers).toEqual([]);
    await emitEvent(pi, "agent_settled", { aborted: false }, ctx);
    expect(pi.entries).toHaveLength(1);

    now = 20_000;
    await emitEvent(pi, "agent_start", {}, ctx);
    expect(shown(state)).toBe("15.0s · 60 t/s");
    await userPrompt(state, "Next task");
    expect(shown(state)).toBe("15.0s · 60 t/s");
    now = 21_000;
    await response(state, 25);
    expect(shown(state)).toBe("15.0s · 60 t/s");
    await emitEvent(pi, "agent_settled", { aborted: false }, ctx);
    expect(pi.entries).toHaveLength(2);
    expect(shown(state)).toBe("1.0s · 25 t/s");
  });

  it("keeps retry backoff in elapsed time without publishing an intermediate result", async () => {
    const state = setup();
    const { pi, ctx } = state;
    await userPrompt(state);
    now = 2000;
    await response(state, 0, "error");
    await emitEvent(pi, "agent_end", {}, ctx);
    now = 5000;
    await emitEvent(pi, "agent_start", {}, ctx);
    await emitEvent(pi, "context", {}, ctx);
    now = 7000;
    await response(state, 80);
    expect(pi.entries).toEqual([]);
    await emitEvent(pi, "agent_settled", { aborted: false }, ctx);
    expect(pi.entries[0].data).toMatchObject({ durationMs: 7000, generationMs: 4000, outputTokens: 80, outcome: "completed" });
    expect(shown(state)).toBe("7.0s · 20 t/s");
  });

  it("keeps pre-request compaction out of model time", async () => {
    const state = setup();
    const { pi, ctx } = state;
    await userPrompt(state, "Compact then answer", false);
    now = 10_000;
    await emitEvent(pi, "session_compact", {}, ctx);
    await emitEvent(pi, "context", {}, ctx);
    now = 12_000;
    await response(state, 100);
    await emitEvent(pi, "agent_settled", { aborted: false }, ctx);
    expect(pi.entries[0].data).toMatchObject({ durationMs: 12_000, generationMs: 2000, outputTokens: 100 });
    expect(shown(state)).toBe("12.0s · 50 t/s");
  });

  it("separates queued user prompts but shows only the final prompt in the footer", async () => {
    const state = setup();
    const { pi, ctx } = state;
    const first = await userPrompt(state, "First");
    now = 2000;
    await response(state, 100);
    now = 5000;
    const second = await userPrompt(state, "Queued follow-up");
    expect(pi.entries[0].data).toMatchObject({ promptEntryId: first, durationMs: 5000, generationMs: 2000, outputTokens: 100 });
    expect(shown(state)).toBe("");
    now = 7000;
    await response(state, 80);
    await emitEvent(pi, "agent_settled", { aborted: false }, ctx);
    expect(pi.entries[1].data).toMatchObject({ promptEntryId: second, durationMs: 2000, generationMs: 2000, outputTokens: 80 });
    expect(shown(state)).toBe("2.0s · 40 t/s");
  });

  it.each(["aborted", "error"])("labels a terminal %s without inventing output usage", async (outcome) => {
    const state = setup();
    const { pi, ctx } = state;
    await userPrompt(state);
    now = 1500;
    await response(state, 0, outcome);
    await emitEvent(pi, "agent_settled", { aborted: outcome === "aborted" }, ctx);
    expect(shown(state)).toBe(`1.5s · ${outcome}`);
  });

  it("records an abort during tool execution at settlement", async () => {
    const state = setup();
    const { pi, ctx } = state;
    await userPrompt(state);
    now = 2000;
    await response(state, 100, "toolUse");
    now = 5000;
    await emitEvent(pi, "agent_settled", { aborted: true }, ctx);
    expect(shown(state)).toBe("5.0s · 50 t/s · aborted");
  });

  it.each(["print", "json", "rpc"])("does not record or publish in %s mode", async (mode) => {
    const state = setup(mode);
    const { pi, ctx } = state;
    await userPrompt(state);
    now = 2000;
    await response(state);
    await emitEvent(pi, "agent_settled", { aborted: false }, ctx);
    expect(pi.entries).toEqual([]);
    expect(shown(state)).toBe("");
    expect(ctx.ui.statuses.size).toBe(0);
  });

  it.each(["session_start", "session_shutdown", "session_tree"])("clears unfinished work on %s", async (event) => {
    const state = setup();
    const { pi, ctx } = state;
    await userPrompt(state);
    now = 2000;
    await response(state);
    await emitEvent(pi, event, {}, ctx);
    await emitEvent(pi, "agent_settled", { aborted: false }, ctx);
    expect(pi.entries).toEqual([]);
    expect(shown(state)).toBe("");
  });

  it("does not manufacture prompt timings for context-only runs", async () => {
    const state = setup();
    const { pi, ctx } = state;
    await emitEvent(pi, "context", {}, ctx);
    now = 2000;
    await response(state);
    await emitEvent(pi, "agent_settled", { aborted: false }, ctx);
    expect(pi.entries).toEqual([]);
  });

  it.each([undefined, -1, NaN, Infinity])("omits aggregate speed when a request has invalid output usage: %s", async (output) => {
    const state = setup();
    const { pi, ctx, session } = state;
    await userPrompt(state);
    now = 2000;
    const message = assistant();
    message.usage.output = output as number;
    await emitEvent(pi, "message_end", { message }, ctx);
    session.appendMessage(message as any);
    await emitEvent(pi, "context", {}, ctx);
    now = 3000;
    await response(state, 50);
    await emitEvent(pi, "agent_settled", { aborted: false }, ctx);
    expect(shown(state)).toBe("3.0s");
  });

  it("rounds speed without dividing by zero", () => {
    expect(formatPromptPerformance({ ...sample, generationMs: 2500, outputTokens: 102 })).toBe("15.0s · 41 t/s");
    expect(formatPromptPerformance({ ...sample, generationMs: 0 })).toBe("15.0s");
  });

  it("restores branch-local metrics on resume without adding them to model context", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-prompt-performance-"));
    try {
      const state = setup("tui", SessionManager.create(directory, directory));
      const { pi, ctx, session } = state;
      const promptEntryId = await userPrompt(state);
      now = 2500;
      await response(state, 100);
      await emitEvent(pi, "agent_settled", { aborted: false }, ctx);
      const reopened = SessionManager.open(session.getSessionFile()!);
      const restored = setup("tui", reopened);
      await emitEvent(restored.pi, "session_start", {}, restored.ctx);
      expect(shown(restored)).toBe("2.5s · 40 t/s");
      expect(promptPerformanceById(reopened.getBranch()).get(promptEntryId)).toMatchObject({ durationMs: 2500, generationMs: 2500, outputTokens: 100 });
      expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      reopened.branch(promptEntryId);
      await emitEvent(restored.pi, "session_tree", {}, restored.ctx);
      expect(shown(restored)).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
