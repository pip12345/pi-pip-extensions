import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./src/agents.ts";
import { createChildSession, type ChildSession } from "./src/child.ts";
import { SubagentRuns } from "./src/runs.ts";

// Exercises the installed Pi host: real resource loading, built-in MCP, and session reuse.
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllEnvs();
});

const agent = (tools: AgentConfig["tools"] = "all"): AgentConfig => ({ name: "fixture", description: "fixture", tools, systemPrompt: "You are a fixture child.", source: "builtin", filePath: "fixture.md" });

async function fixture(replies: AssistantMessage["content"][] = []) {
  const root = mkdtempSync(join(tmpdir(), "pip-subagent-child-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  // The MCP extension reads mcp.json from Pi's agent directory.
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-cache.json"),
    refreshOnCreate: false, allowModelNetwork: false,
  });
  const requests: TranscriptContext[] = [];
  // When set, the next provider reply waits for this promise, so the child stays mid-turn.
  let nextReplyGate: Promise<void> | undefined;
  modelRuntime.registerProvider("fixture", {
    apiKey: "local-fixture-not-a-credential", api: "fixture-api", baseUrl: "http://invalid.localhost",
    models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      requests.push(structuredClone(context));
      const content = replies.shift() ?? [{ type: "text" as const, text: "done" }];
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, content,
        stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      const gate = nextReplyGate;
      nextReplyGate = undefined;
      void (async () => {
        await gate;
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end();
      })();
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const children: ChildSession[] = [];
  const openChild = async (options: { tools?: AgentConfig["tools"]; sessionManager?: SessionManager } = {}) => {
    const child = await createChildSession({
      cwd: root, agentDir: root, agent: agent(options.tools), model: "fixture/model", projectTrusted: true,
      sessionManager: options.sessionManager ?? SessionManager.inMemory(root), modelRuntime, settingsManager,
    });
    children.push(child);
    return child;
  };
  const open = async (options: { tools?: AgentConfig["tools"]; sessionManager?: SessionManager } = {}) => (await openChild(options)).session;
  cleanups.push(() => { for (const child of children) void child.close(); });
  const runs = () => {
    const created = new SubagentRuns({
      createChild: async (options) => {
        const child = await createChildSession({ ...options, agentDir: root, modelRuntime, settingsManager });
        children.push(child);
        return child;
      },
      maxRunning: () => 5,
      onBackgroundDone: () => undefined,
    });
    cleanups.push(() => void created.close());
    return created;
  };
  const holdNextReply = (gate: Promise<void>) => { nextReplyGate = gate; };
  return { root, requests, open, openChild, runs, holdNextReply, modelRuntime, settingsManager };
}

function writeExtension(root: string, name: string, tool: string) {
  mkdirSync(join(root, "extensions", name), { recursive: true });
  writeFileSync(join(root, "extensions", name, "index.ts"), `export default function (pi) {
  pi.registerTool({ name: ${JSON.stringify(tool)}, label: ${JSON.stringify(tool)}, description: "marker", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } });
}
`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Child extension whose input hook awaits the test's gate, like a slow input or auth hook. */
function writeInputGate(root: string, gate: (text: string) => Promise<void>) {
  (globalThis as any).__subagentTestInputGate = gate;
  cleanups.push(() => { delete (globalThis as any).__subagentTestInputGate; });
  mkdirSync(join(root, "extensions", "input-gate"), { recursive: true });
  writeFileSync(join(root, "extensions", "input-gate", "index.ts"), `export default function (pi) {
  pi.on("input", async (event) => {
    await globalThis.__subagentTestInputGate?.(event.text);
    return { action: "continue" };
  });
}
`);
}

function writeEchoServer(root: string) {
  writeFileSync(join(root, "mcp.json"), JSON.stringify({
    mcpServers: { echo: { command: process.execPath, args: [join(import.meta.dirname, "test-fixtures", "echo-mcp-server.mjs"), join(root, "server.pid")], exposure: "direct" } },
  }));
}

describe("child sessions", () => {
  it("reach MCP server tools configured for Pi, and stop the server on close", async () => {
    const f = await fixture([
      [{ type: "toolCall", id: "call-1", name: "mcp__echo__echo", arguments: { text: "hi" } }],
      [{ type: "text", text: "finished" }],
    ]);
    writeEchoServer(f.root);
    const child = await f.openChild();
    const session = child.session;
    await session.prompt("use echo");
    const toolResult = session.messages.find((message: any) => message.role === "toolResult") as any;
    expect(toolResult).toMatchObject({ toolName: "mcp__echo__echo", isError: false });
    expect(toolResult.content[0].text).toBe("echo: hi");
    expect(session.getLastAssistantText()).toBe("finished");
    const pid = Number(readFileSync(join(f.root, "server.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    await child.close();
    await expect.poll(() => { try { process.kill(pid, 0); return "alive"; } catch { return "gone"; } }, { timeout: 5000 }).toBe("gone");
  }, 20_000);

  it.each([
    { tools: "none" as const, active: [] },
    { tools: ["read"], active: ["read"] },
    { tools: ["read", "mcp__echo__echo"], active: ["mcp__echo__echo", "read"] },
  ])("limits MCP tools that connect after startup to the agent's tool list $tools", async ({ tools, active }) => {
    const f = await fixture();
    writeEchoServer(f.root);
    const session = await f.open({ tools });
    // The first prompt waits for servers with direct tools, so the echo tool is registered by now.
    await session.prompt("hello");
    expect(readFileSync(join(f.root, "server.pid"), "utf8")).toMatch(/^\d+$/);
    expect(session.getActiveToolNames().sort()).toEqual(active);
  }, 20_000);

  it("skips denylisted extension packages and applies the agent's tool list", async () => {
    const f = await fixture();
    writeExtension(f.root, "pi-stats", "denied_marker");
    writeExtension(f.root, "allowed-ext", "allowed_marker");
    const all = await f.open();
    const names = all.getAllTools().map((tool) => tool.name);
    expect(names).toContain("allowed_marker");
    expect(names).not.toContain("denied_marker");
    const limited = await f.open({ tools: ["read", "allowed_marker"] });
    expect(limited.getActiveToolNames().sort()).toEqual(["allowed_marker", "read"]);
  });

  it("appends the agent prompt and continues a conversation through a reused session manager", async () => {
    const f = await fixture([[{ type: "text", text: "first answer" }], [{ type: "text", text: "second answer" }]]);
    const sessionManager = SessionManager.inMemory(f.root);
    const first = await f.openChild({ sessionManager });
    await first.session.prompt("first question");
    await first.close();
    const second = await f.open({ sessionManager });
    await second.prompt("second question");
    expect(second.getLastAssistantText()).toBe("second answer");
    const lastRequest = JSON.stringify(f.requests.at(-1));
    expect(lastRequest).toContain("first question");
    expect(lastRequest).toContain("first answer");
    expect(lastRequest).toContain("You are a fixture child.");
  });

  it("resolves models from providers that extensions register", async () => {
    const f = await fixture();
    mkdirSync(join(f.root, "extensions", "provider-ext"), { recursive: true });
    writeFileSync(join(f.root, "extensions", "provider-ext", "index.ts"), `export default function (pi) {
  pi.registerProvider("ext-provider", { apiKey: "local-fixture-not-a-credential", api: "openai-completions", baseUrl: "http://invalid.localhost",
    models: [{ id: "ext-model", name: "Ext", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
}
`);
    const child = await createChildSession({
      cwd: f.root, agentDir: f.root, agent: agent(), model: "ext-provider/ext-model", projectTrusted: true,
      sessionManager: SessionManager.inMemory(f.root), modelRuntime: f.modelRuntime, settingsManager: f.settingsManager,
    });
    expect(child.session.model).toMatchObject({ provider: "ext-provider", id: "ext-model" });
    await child.close();
  });

  it("lists the provider's models when the requested model is unknown", async () => {
    const f = await fixture();
    const open = (model: string) => createChildSession({
      cwd: f.root, agentDir: f.root, agent: agent(), model, projectTrusted: true,
      sessionManager: SessionManager.inMemory(f.root), modelRuntime: f.modelRuntime, settingsManager: f.settingsManager,
    });
    await expect(open("fixture/missing")).rejects.toThrow("Unknown subagent model: fixture/missing. Available fixture models: fixture/model");
    await expect(open("nobody/model")).rejects.toThrow('No available models for provider "nobody".');
  });
});

describe("child runs", () => {
  it("stops a run cancelled while its prompt is still in preflight before any model request", async () => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    writeInputGate(f.root, async () => { entered.resolve(); await release.promise; });
    const runs = f.runs();
    const run = runs.launch({ agent: agent(), prompt: "task", cwd: f.root, projectTrusted: true, background: true });
    await entered.promise;
    const cancelled = runs.cancel(run);
    release.resolve();
    await cancelled;
    expect(run.status).toBe("cancelled");
    expect(f.requests).toHaveLength(0);
  });

  it("delivers a steering note that arrives after the child's turn ended", async () => {
    const f = await fixture([[{ type: "text", text: "first answer" }], [{ type: "text", text: "saw the note" }]]);
    const steerEntered = deferred();
    const steerRelease = deferred();
    writeInputGate(f.root, async (text) => {
      if (!text.includes("<subagent_steering>")) return;
      steerEntered.resolve();
      await steerRelease.promise;
    });
    const reply = deferred();
    f.holdNextReply(reply.promise);
    const runs = f.runs();
    const run = runs.launch({ agent: agent(), prompt: "task", cwd: f.root, projectTrusted: true, background: true });
    await expect.poll(() => f.requests.length).toBe(1);
    const sent = runs.message(run, "also check the tests");
    await steerEntered.promise;
    // The turn ends while the note is still inside the input hook.
    reply.resolve();
    await expect.poll(() => run.session?.isStreaming).toBe(false);
    steerRelease.resolve();
    await expect(sent).resolves.toBe("steered");
    await run.done;
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1])).toContain("also check the tests");
    expect(run).toMatchObject({ status: "completed", resultText: "saw the note" });
  });
});
