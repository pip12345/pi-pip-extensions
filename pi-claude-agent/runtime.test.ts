import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { normalizeContext, type AssistantMessage, type Message, type Model, type ToolResultMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { ClaudeRuntime } from "./src/runtime.ts";
import { modelDefinition } from "./src/provider.ts";
import { fakeSDK, type Script } from "./testing.ts";

const model: Model<"claude-agent-sdk"> = {
  ...modelDefinition({ value: "sonnet", displayName: "Sonnet", description: "", supportsThinkingOff: true, supportedEffortLevels: ["low", "medium", "high", "max"] }, false),
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
};
const user = (text: string): Message => ({ role: "user", content: text, timestamp: Date.now() });
const tool = { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };
const context = (messages: Message[], tools = [tool]): TranscriptContext => normalizeContext({ messages: [{ role: "system", content: "Follow Pi's rules.", toolsAdded: tools, timestamp: 0 }, ...messages] });
const result = (id: string, text: string, isError = false): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError, timestamp: Date.now() });
const text = (message: AssistantMessage): string => message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
const runtimes: ClaudeRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); vi.restoreAllMocks(); });
function setup(script: Script, idleMs = 60_000) {
  const fake = fakeSDK(script);
  const runtime = new ClaudeRuntime({ loadSDK: async () => fake.sdk, executable: () => "/test/claude", cwd: () => "/project", idleMs });
  runtimes.push(runtime);
  return { runtime, ...fake };
}
const options = { sessionId: "pi-session", reasoning: "high" as const };

describe("Claude Agent runtime", () => {
  it("streams Unicode once, balances events, and deduplicates SDK token reports", async () => {
    const { runtime, runs } = setup((run) => { run.reply("hello 🦊 café"); run.result(); });
    const stream = runtime.stream(model, context([user("hello")]), options);
    const events = [];
    for await (const event of stream) events.push(event.type);
    const answer = await stream.result();
    expect(text(answer)).toBe("hello 🦊 café");
    expect(events[0]).toBe("start");
    expect(events.at(-1)).toBe("done");
    expect(events.filter((type) => type === "text_start")).toHaveLength(1);
    expect(events.filter((type) => type === "text_end")).toHaveLength(1);
    expect(answer.usage).toMatchObject({ input: 12, output: 4, cacheRead: 20, cacheWrite: 5, totalTokens: 41 });
    expect(answer.usage.cost.total).toBeGreaterThan(0);
    expect(runs[0]!.options).toMatchObject({ tools: [], settingSources: [], skills: [], permissionMode: "dontAsk", verbatimPrompts: true, persistSession: false, effort: "high" });
    expect(runs[0]!.options.systemPrompt).toMatchObject({ preset: "claude_code", append: expect.stringContaining("Follow Pi's rules.") });
  });

  it("accepts empty text responses", async () => {
    const { runtime } = setup((run) => { run.reply(""); run.result(); });
    expect(await runtime.stream(model, context([user("")]), options).result()).toMatchObject({ content: [], stopReason: "stop" });
  });

  it("keeps one native turn alive across two tool steps and returns Pi errors/images unchanged", async () => {
    const { runtime, runs } = setup(async (run) => {
      run.reply("Checking", [{ id: "call-1", name: "mcp__pi__t0_read", input: { path: "one" } }, { id: "call-2", name: "mcp__pi__t0_read", input: { path: "two" } }]);
      await run.call("call-1", "t0_read", { path: "one" });
      await run.call("call-2", "t0_read", { path: "two" });
      run.reply("Again", [{ id: "call-3", name: "mcp__pi__t0_read", input: { path: "three" } }]);
      await run.call("call-3", "t0_read", { path: "three" });
      run.reply("finished"); run.result();
    }, 10);
    const messages = [user("read files")];
    const first = await runtime.stream(model, context(messages), options).result();
    expect(first.stopReason).toBe("toolUse");
    expect(first.content.filter((part) => part.type === "toolCall").map((part) => part.name)).toEqual(["read", "read"]);
    await new Promise((done) => setTimeout(done, 30));
    expect(runs[0]!.closed).toBe(false);
    const image: ToolResultMessage = { ...result("call-1", "image"), content: [{ type: "image", data: "YWJj", mimeType: "image/png" }] };
    messages.push(first, image, result("call-2", "blocked by Pi permission hook", true));
    const second = await runtime.stream(model, context(messages), options).result();
    expect(second.stopReason).toBe("toolUse");
    messages.push(second, result("call-3", "third"));
    const third = await runtime.stream(model, context(messages), options).result();
    expect(text(third)).toBe("finished");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.inputs).toHaveLength(1);
    expect(runs[0]!.interrupts).toBe(0);
    expect(runs[0]!.outputs[0]).toMatchObject({ content: [{ type: "image", data: "YWJj", mimeType: "image/png" }] });
    expect(runs[0]!.outputs[1]).toMatchObject({ isError: true, content: [{ text: "blocked by Pi permission hook" }] });
  });

  it("continues ordinary user messages without replaying prior history", async () => {
    const { runtime, runs } = setup((run, _, index) => { run.reply(`answer ${index}`); run.result(); });
    const first = user("one");
    const answer = await runtime.stream(model, context([first]), options).result();
    expect(text(await runtime.stream(model, context([first, answer, user("two")]), options).result())).toBe("answer 1");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.inputs[1]!.message.content).toEqual([{ type: "text", text: "two" }]);
  });

  it("adds missed cross-provider history as a checkpoint without impersonating assistant messages", async () => {
    const { runtime, runs } = setup((run) => { run.reply("answer"); run.result(); });
    const first = user("one");
    const answer = await runtime.stream(model, context([first]), options).result();
    const other = { ...answer, provider: "other", content: [{ type: "text" as const, text: "other model reply" }] };
    await runtime.stream(model, context([first, answer, user("other"), other, user("back")]), options).result();
    expect(runs).toHaveLength(1);
    expect(JSON.stringify(runs[0]!.inputs[1])).toContain("<conversation-checkpoint>");
    expect(JSON.stringify(runs[0]!.inputs[1])).toContain("other model reply");
  });

  it("rebuilds after edits, branches, and compaction instead of retaining removed history", async () => {
    const { runtime, runs } = setup((run) => { run.reply("answer"); run.result(); });
    const original = user("secret branch that is later removed");
    await runtime.stream(model, context([original]), options).result();
    await runtime.stream(model, context([user("edited branch")]), options).result();
    expect(runs).toHaveLength(2);
    expect(runs[0]!.closed).toBe(true);
    expect(JSON.stringify(runs[1]!.inputs)).not.toContain("secret branch");
    await runtime.stream(model, context([user("compaction summary")]), options).result();
    expect(runs).toHaveLength(3);
    expect(runs[1]!.closed).toBe(true);
  });

  it("restarts with current tool and prompt definitions when the loadout changes", async () => {
    const { runtime, runs } = setup((run) => { run.reply("answer"); run.result(); });
    const first = user("one");
    const answer = await runtime.stream(model, context([first]), options).result();
    await runtime.stream(model, context([first, answer, user("two")], []), options).result();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.options.mcpServers).toEqual({});
  });

  it("interrupts before resolving parked handlers on shutdown and rebuilds on resume", async () => {
    const { runtime, runs } = setup(async (run) => {
      run.reply("", [{ id: "call", name: "mcp__pi__t0_read", input: {} }]);
      await run.call("call", "t0_read");
      if (!run.closed) { run.reply("should not run during shutdown"); run.result(); }
    });
    const answer = await runtime.stream(model, context([user("read")]), options).result();
    expect(answer.stopReason).toBe("toolUse");
    await runtime.close();
    expect(runs[0]!.interrupts).toBe(1);
    expect(runs[0]!.closed).toBe(true);
    expect(runs[0]!.apiCalls).toBe(1);
  });

  it("cancels active inference and emits one aborted terminal event", async () => {
    const { runtime, runs } = setup(() => {});
    const abort = new AbortController();
    const stream = runtime.stream(model, context([user("wait")]), { ...options, signal: abort.signal });
    await vi.waitFor(() => expect(runs[0]?.inputs).toHaveLength(1));
    abort.abort(new Error("cancelled"));
    expect(await stream.result()).toMatchObject({ stopReason: "aborted", errorMessage: "cancelled" });
    expect(runs[0]!.closed).toBe(true);
    expect(runs[0]!.interrupts).toBe(1);
  });

  it("does not let a cancelled queued request release a session still in use", async () => {
    let done!: () => void;
    const wait = new Promise<void>((resolve) => { done = resolve; });
    const { runtime, runs } = setup(async (run) => { if (runs.length === 1) await wait; run.reply("answer"); run.result(); });
    const first = runtime.stream(model, context([user("one")]), options).result();
    await vi.waitFor(() => expect(runs[0]?.inputs).toHaveLength(1));
    const abort = new AbortController();
    const second = runtime.stream(model, context([user("two")]), { ...options, signal: abort.signal }).result();
    const third = runtime.stream(model, context([user("three")]), options).result();
    abort.abort();
    expect((await second).stopReason).toBe("aborted");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runs).toHaveLength(1);
    done();
    expect((await first).stopReason).toBe("stop");
    expect((await third).stopReason).toBe("stop");
  });

  it("forwards raw SDK events but never manufactures HTTP response callbacks", async () => {
    const { runtime } = setup((run) => { run.reply("answer"); run.result(); });
    const raw = vi.fn(); const response = vi.fn(); const payload = vi.fn();
    await runtime.stream(model, context([user("one")]), { ...options, onProviderStreamEvent: raw, onResponse: response, onPayload: payload }).result();
    expect(raw).toHaveBeenCalled(); expect(response).not.toHaveBeenCalled();
    expect(payload.mock.calls[0]![0]).toMatchObject({ model: "sonnet", tools: [tool] });
  });

  it("rejects request replacement rather than silently ignoring an extension's changes", async () => {
    const { runtime, runs } = setup(() => {});
    const answer = await runtime.stream(model, context([user("one")]), { ...options, onPayload: () => ({ model: "different" }) }).result();
    expect(answer.stopReason).toBe("error"); expect(answer.errorMessage).toContain("does not support replacing");
    expect(runs).toHaveLength(0);
  });

  it("closes idle sessions and reconstructs the next request from Pi history", async () => {
    const { runtime, runs } = setup((run) => { run.reply("answer"); run.result(); }, 10);
    const first = user("one");
    const answer = await runtime.stream(model, context([first]), options).result();
    await vi.waitFor(() => expect(runs[0]!.closed).toBe(true));
    await runtime.stream(model, context([first, answer, user("two")]), options).result();
    expect(runs).toHaveLength(2);
    expect(JSON.stringify(runs[1]!.inputs)).toContain("<conversation-checkpoint>");
  });

  it("does not offer tools when the caller explicitly selects toolChoice none", async () => {
    const { runtime, runs } = setup((run) => { run.reply("answer"); run.result(); });
    await runtime.stream(model, context([user("one")]), { ...options, toolChoice: "none" }).result();
    expect(runs[0]!.options.mcpServers).toEqual({});
  });

  it("shuts down active inference without leaving the stream waiting", async () => {
    const { runtime, runs } = setup(() => {});
    const stream = runtime.stream(model, context([user("wait")]), options);
    await vi.waitFor(() => expect(runs[0]?.inputs).toHaveLength(1));
    await runtime.close();
    expect((await stream.result()).stopReason).toBe("aborted");
    expect(runs[0]!.closed).toBe(true);
  });

  it("discards failed native context before Pi retries a request", async () => {
    const { runtime, runs } = setup((run) => {
      if (runs.length === 1) run.emit({ type: "result", subtype: "success", is_error: true, result: "upstream service unavailable" });
      else { run.reply("retry succeeded"); run.result(); }
    });
    const request = context([user("try")]);
    expect((await runtime.stream(model, request, options).result()).stopReason).toBe("error");
    expect(text(await runtime.stream(model, request, options).result())).toBe("retry succeeded");
    expect(runs).toHaveLength(2); expect(runs[0]!.closed).toBe(true);
  });

  it("preserves image input when rebuilding a transcript checkpoint", async () => {
    const { runtime, runs } = setup((run) => { run.reply("answer"); run.result(); });
    await runtime.stream(model, context([{ role: "user", content: [{ type: "image", data: "YWJj", mimeType: "image/png" }], timestamp: 1 }]), options).result();
    expect(runs[0]!.inputs[0]!.message.content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } }]);
  });

  it("passes explicit connection settings to the real CLI and disables thinking when Pi requests none", async () => {
    const { runtime, runs } = setup((run) => { run.reply("answer"); run.result(); });
    await runtime.stream({ ...model, baseUrl: "https://example.test/anthropic" }, context([user("one")]), {
      sessionId: "other", apiKey: "test-api-key", headers: { "X-Test": "tenant" }, maxTokens: 1234,
    }).result();
    expect(runs[0]!.options).toMatchObject({ thinking: { type: "disabled" }, env: { ANTHROPIC_BASE_URL: "https://example.test/anthropic", ANTHROPIC_API_KEY: "test-api-key", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1234" } });
    expect(runs[0]!.options.env!.ANTHROPIC_CUSTOM_HEADERS).toContain("X-Test: tenant");
  });
});
