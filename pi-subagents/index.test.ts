import { describe, expect, it } from "vitest";
import { createMockCtx, createMockPi, emitEvent, getRegisteredTool } from "../pip-common/testing.ts";
import { getPipSettingsRegistry } from "../pip-common/index.ts";
import { createSubagentsExtension } from "./index.ts";
import { childExtensionAllowed, type ChildSessionOptions } from "./src/child.ts";
import { SubagentRuns } from "./src/runs.ts";
import { SubagentViewer } from "./src/view.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Child session double: answers each prompt with "<reply>: <prompt>" unless held or failing. */
class FakeChild {
  messages: any[] = [];
  steered: string[] = [];
  aborted = false;
  disposed = false;
  isStreaming = false;
  hold?: ReturnType<typeof deferred>;
  fail?: string;
  state: any = { streamingMessage: undefined, errorMessage: undefined };
  private listeners = new Set<(event: any) => void>();

  constructor(readonly options: ChildSessionOptions, private readonly reply = "done") {}

  subscribe(listener: (event: any) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: any) {
    for (const listener of this.listeners) listener(event);
  }

  async prompt(text: string) {
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    this.isStreaming = true;
    this.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } });
    if (this.hold) await this.hold.promise;
    const message = this.aborted
      ? { role: "assistant", content: [], stopReason: "aborted", usage: { input: 1, output: 0, cost: { total: 0 } } }
      : this.fail
        ? { role: "assistant", content: [], stopReason: "error", errorMessage: this.fail, usage: { input: 2, output: 0, cost: { total: 0 } } }
        : { role: "assistant", content: [{ type: "text", text: `${this.reply}: ${text}` }], stopReason: "stop", usage: { input: 10, output: 5, cost: { total: 0.01 } } };
    this.messages.push(message);
    this.emit({ type: "message_end", message });
    this.isStreaming = false;
  }

  async steer(text: string) {
    this.steered.push(text);
    return "queued";
  }

  async abort() {
    this.aborted = true;
    this.hold?.resolve();
  }

  dispose() {
    this.disposed = true;
  }

  getLastAssistantText() {
    const last = [...this.messages].reverse().find((message) => message.role === "assistant");
    return last?.content?.find((part: any) => part.type === "text")?.text;
  }
}

function setup(configure: (child: FakeChild) => void = () => undefined) {
  const children: FakeChild[] = [];
  const pi = createMockPi();
  createSubagentsExtension({
    createChild: async (options) => {
      const child = new FakeChild(options);
      configure(child);
      children.push(child);
      return { session: child as any, close: async () => child.dispose() };
    },
  })(pi as any);
  const ctx = createMockCtx({ model: { provider: "parent-provider", id: "parent-model" }, projectTrusted: false });
  const call = (tool: string, params: any, signal?: AbortSignal, onUpdate?: (update: any) => void) => getRegisteredTool(pi, tool).execute("call", params, signal, onUpdate, ctx);
  return { pi, ctx, children, call };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("subagent tool schemas", () => {
  it("only exposes model on launch, and every message param is required", () => {
    const { pi } = setup();
    const launch = getRegisteredTool(pi, "subagent").parameters;
    const message = getRegisteredTool(pi, "subagent_message").parameters;
    const status = getRegisteredTool(pi, "subagent_status").parameters;
    expect(launch.required).toEqual(["agent", "prompt"]);
    expect(Object.keys(launch.properties)).toEqual(["agent", "prompt", "model", "background"]);
    expect(message.required).toEqual(["id", "message"]);
    expect(Object.keys(message.properties)).not.toContain("model");
    expect(status.required ?? []).toEqual([]);
    expect(Object.keys(status.properties)).toEqual(["id"]);
  });

  it("lists agent names and descriptions in the system prompt", async () => {
    const { pi, ctx } = setup();
    const event = { systemPromptOptions: { sections: {} } as any };
    await emitEvent(pi, "before_agent_start", event, ctx);
    const text = JSON.stringify(event.systemPromptOptions);
    expect(text).toContain("explore: Fast read-only code explorer");
    expect(text).toContain("general: General-purpose subagent");
  });
});

describe("subagent launch", () => {
  it("returns the result with cumulative usage and passes the parent's model and trust", async () => {
    const { call, children } = setup();
    const result = await call("subagent", { agent: "general", prompt: "find it" });
    expect(result.content[0].text).toContain("<subagent_result>\ndone: find it\n</subagent_result>");
    expect(result.details.run).toMatchObject({ agent: "general", status: "completed", toolCalls: 1, model: "parent-provider/parent-model", usage: { input: 10, output: 5, cost: 0.01 } });
    expect(result.details.run.id).toMatch(/^sa_/);
    expect(children[0].options).toMatchObject({ model: "parent-provider/parent-model", projectTrusted: false });
    expect(children[0].disposed).toBe(true);
  });

  it("prefers an explicit model override", async () => {
    const { call, children } = setup();
    await call("subagent", { agent: "explore", prompt: "x", model: "other/model-1" });
    expect(children[0].options.model).toBe("other/model-1");
    await expect(call("subagent", { agent: "explore", prompt: "x", model: "no-slash" })).rejects.toThrow("provider/model-id");
  });

  it("rejects unknown agents with the available names", async () => {
    const { call } = setup();
    await expect(call("subagent", { agent: "nope", prompt: "x" })).rejects.toThrow(/Unknown subagent agent: nope\. Available: .*explore/);
  });

  it("fails the tool call when the child turn errors, while keeping the run addressable", async () => {
    const { call } = setup((child) => { child.fail = "rate limited"; });
    const error = await call("subagent", { agent: "general", prompt: "x" }).catch((caught: Error) => caught);
    expect(error.message).toMatch(/^Subagent (sa_\w+) failed: rate limited$/);
    const id = /^Subagent (sa_\w+)/.exec(error.message)![1];
    const status = await call("subagent_status", { id });
    expect(status.details.run).toMatchObject({ status: "error", errorText: "rate limited", usage: { input: 2 } });
  });

  it("cancels a foreground run when the parent tool call is aborted", async () => {
    const { call, children } = setup((child) => { child.hold = deferred(); });
    const controller = new AbortController();
    const pending = call("subagent", { agent: "general", prompt: "slow" }, controller.signal);
    await flush();
    controller.abort();
    await expect(pending).rejects.toThrow(/was cancelled/);
    expect(children[0].aborted).toBe(true);
  });

  it("streams progress snapshots to onUpdate", async () => {
    const updates: any[] = [];
    const { call } = setup();
    await call("subagent", { agent: "general", prompt: "x" }, undefined, (update) => updates.push(update));
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.at(-1).details.run.status).toBe("completed");
  });

  it("enforces the running limit", async () => {
    const { pi, call } = setup((child) => { child.hold = deferred(); });
    getPipSettingsRegistry(pi).set("subagents.maxRunning", 1);
    await call("subagent", { agent: "general", prompt: "a", background: true });
    await expect(call("subagent", { agent: "general", prompt: "b", background: true })).rejects.toThrow("Maximum concurrent subagents reached (1)");
  });
});

describe("background subagents", () => {
  it("returns immediately and reports the result as a follow-up message", async () => {
    const { pi, call, children } = setup((child) => { child.hold = deferred(); });
    const started = await call("subagent", { agent: "general", prompt: "long", background: true });
    expect(started.content[0].text).toContain("state: running");
    await flush();
    children[0].hold!.resolve();
    await flush();
    await flush();
    expect(pi.userMessages).toHaveLength(1);
    expect(pi.userMessages[0].options).toEqual({ deliverAs: "followUp" });
    expect(pi.userMessages[0].message).toContain(`Background subagent ${started.details.run.id} finished.`);
    expect(pi.userMessages[0].message).toContain("done: long");
  });

  it("does not report results when injection is disabled", async () => {
    const { pi, call } = setup();
    getPipSettingsRegistry(pi).set("subagents.injectBackgroundResults", false);
    const started = await call("subagent", { agent: "general", prompt: "x", background: true });
    expect(started.content[0].text).toContain("use subagent_status later");
    await flush();
    await flush();
    expect(pi.userMessages).toHaveLength(0);
  });

  it("stops runs without reporting them when the parent session shuts down", async () => {
    const { pi, ctx, call, children } = setup((child) => { child.hold = deferred(); });
    const started = await call("subagent", { agent: "general", prompt: "x", background: true });
    await flush();
    await emitEvent(pi, "session_shutdown", { reason: "new" }, ctx);
    expect(children[0].aborted).toBe(true);
    expect(children[0].disposed).toBe(true);
    expect(pi.userMessages).toHaveLength(0);
    await expect(call("subagent_status", { id: started.details.run.id })).rejects.toThrow("Subagent not found");
    // The extension keeps working for the next session.
    children.length = 0;
    await expect(call("subagent", { agent: "general", prompt: "y", background: true })).resolves.toBeTruthy();
  });
});

describe("subagent_message", () => {
  it("steers a running subagent with a wrapped note", async () => {
    const { call, children } = setup((child) => { child.hold = deferred(); });
    const started = await call("subagent", { agent: "general", prompt: "x", background: true });
    await flush();
    const result = await call("subagent_message", { id: started.details.run.id, message: "also check tests" });
    expect(result.content[0].text).toContain("Steering note sent");
    expect(children[0].steered[0]).toMatch(/^<subagent_steering>\n.*\n\nalso check tests\n<\/subagent_steering>$/);
  });

  it("continues a finished subagent in a new session over the same conversation", async () => {
    const { call, children } = setup();
    const first = await call("subagent", { agent: "general", prompt: "first" });
    const second = await call("subagent_message", { id: first.details.run.id, message: "second" });
    expect(second.content[0].text).toContain("done: second");
    expect(children).toHaveLength(2);
    expect(children[1].options.sessionManager).toBe(children[0].options.sessionManager);
    expect(second.details.run).toMatchObject({ id: first.details.run.id, toolCalls: 2, usage: { input: 20, output: 10 } });
  });

  it("refuses a message while the previous turn's session is still closing", async () => {
    const closing = deferred();
    const runs = new SubagentRuns({
      createChild: async (options) => ({ session: new FakeChild(options) as any, close: () => closing.promise }),
      maxRunning: () => 5,
      onBackgroundDone: () => undefined,
    });
    const run = runs.launch({ agent: { name: "general", description: "", tools: "all", systemPrompt: "", source: "builtin", filePath: "" }, prompt: "x", cwd: "/", projectTrusted: true, background: true });
    await flush();
    expect(run.status).toBe("running");
    await expect(runs.message(run, "next")).rejects.toThrow("starting or finishing a turn");
    closing.resolve();
    await run.done;
    expect(run.status).toBe("completed");
    expect(run.session).toBeUndefined();
  });

  it("names known ids when the id is unknown", async () => {
    const { call } = setup();
    const first = await call("subagent", { agent: "general", prompt: "x" });
    await expect(call("subagent_message", { id: "sa_missing", message: "x" })).rejects.toThrow(`Known ids: ${first.details.run.id}`);
  });
});

describe("subagent_status", () => {
  it("lists runs when id is omitted", async () => {
    const { call } = setup();
    expect((await call("subagent_status", {})).content[0].text).toBe("No subagents in this session.");
    const run = await call("subagent", { agent: "explore", prompt: "look   around" });
    expect((await call("subagent_status", {})).content[0].text).toBe(`${run.details.run.id} [completed] explore parent-provider/parent-model: look around`);
  });
});

describe("child extension denylist", () => {
  it("matches the package directory of the extension entry", () => {
    expect(childExtensionAllowed({ path: "/x/extensions-pip/pi-stats/index.ts" })).toBe(false);
    expect(childExtensionAllowed({ path: "/x/extensions-pip/pi-subagents/index.ts" })).toBe(false);
    expect(childExtensionAllowed({ path: "/x/extensions-pip/pi-question/index.ts" })).toBe(false);
    expect(childExtensionAllowed({ path: "/x/extensions-pip/pi-prompt-profiles/index.ts" })).toBe(false);
    expect(childExtensionAllowed({ path: "/x/pi-subagents/node_modules/pip-common/index.ts" })).toBe(true);
    expect(childExtensionAllowed({ path: "/x/extensions-pip/pi-secrets-guard/index.ts" })).toBe(true);
    expect(childExtensionAllowed({ path: "builtin:mcp" })).toBe(true);
  });
});

describe("SubagentViewer", () => {
  it("renders the live transcript with steering notes unwrapped", async () => {
    let child!: FakeChild;
    const runs = new SubagentRuns({
      createChild: async (options) => {
        child = new FakeChild(options);
        child.hold = deferred();
        return { session: child as any, close: async () => child.dispose() };
      },
      maxRunning: () => 5,
      onBackgroundDone: () => undefined,
    });
    const run = runs.launch({ agent: { name: "general", description: "", tools: "all", systemPrompt: "", source: "builtin", filePath: "" }, prompt: "inspect", cwd: "/", projectTrusted: true, background: true });
    await flush();
    await runs.message(run, "focus on auth");
    child.messages.push({ role: "user", content: [{ type: "text", text: child.steered[0] }] });
    child.messages.push({ role: "assistant", content: [{ type: "text", text: "looking" }, { type: "toolCall", name: "grep", arguments: { pattern: "auth" } }] });
    child.messages.push({ role: "toolResult", content: [{ type: "text", text: "\nsrc/auth.ts:1" }], isError: false });
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const viewer = new SubagentViewer({ terminal: { rows: 30 } }, theme, () => undefined, runs, run);
    const text = viewer.render(100).join("\n");
    viewer.dispose();
    expect(text).toContain("user › inspect");
    expect(text).toContain("steer › focus on auth");
    expect(text).not.toContain("<subagent_steering>");
    expect(text).toContain("agent › looking");
    expect(text).toContain("tool › grep auth");
    expect(text).toContain("✓ src/auth.ts:1");
    await runs.close();
  });
});
