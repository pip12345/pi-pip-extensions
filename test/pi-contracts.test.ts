import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { piInstructions } from "../pi-claude-agent/src/runtime.ts";

// Exercise the installed host, not the permissive ExtensionAPI unit-test mock.
// Discovery, credentials, catalog refresh, retries, and compaction are isolated.
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture(extension: (pi: ExtensionAPI) => void, replies: AssistantMessage["content"][] = []) {
  const root = mkdtempSync(join(tmpdir(), "pip-pi-contract-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    // Keep Pi's native transcript-loadout restoration enabled while isolating built-ins.
    // noTools: "builtin" disables that restoration as well as initial built-in selection.
    defaultTools: [],
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(root, "models-cache.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const requests: TranscriptContext[] = [];
  modelRuntime.registerProvider("pip-contract", {
    apiKey: "local-fixture-not-a-credential",
    api: "pip-contract-api",
    baseUrl: "http://invalid.localhost",
    models: [{
      id: "deterministic", name: "Deterministic local fixture", reasoning: false,
      input: ["text", "image"], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
      requests.push(structuredClone(context));
      const content = replies.shift() ?? [{ type: "text" as const, text: "done" }];
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content, stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end();
      return stream;
    },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [extension],
  });
  const sessions: AgentSession[] = [];
  const open = async (sessionManager: SessionManager) => {
    // Reopening needs a fresh extension runtime; disposed contexts must not be reused.
    await resourceLoader.reload();
    expect(resourceLoader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({
      cwd: root, agentDir: root, settingsManager, modelRuntime, resourceLoader,
      model: modelRuntime.getModel("pip-contract", "deterministic")!,
      thinkingLevel: "off", sessionManager,
    });
    sessions.push(session);
    await session.bindExtensions({ mode: "print", onError: (error) => { throw new Error(error.error); } });
    return session;
  };
  cleanups.push(() => { for (const session of sessions) session.dispose(); });
  return { root, requests, open };
}

describe("Pi 1.5.2 public contracts", () => {
  it("validates arguments before tool_call and finalizes invalid, unknown, blocked, and thrown calls", async () => {
    const calls: string[] = [];
    const results: string[] = [];
    const ended: { id: string; isError: boolean }[] = [];
    const executed: number[] = [];
    const f = await fixture((pi) => {
      pi.registerTool({
        name: "checked", label: "Checked", description: "Contract fixture",
        parameters: Type.Object({ count: Type.Number() }),
        async execute(_id, args) {
          executed.push(args.count);
          if (args.count === 3) throw new Error("fixture execution failure");
          return { content: [{ type: "text", text: String(args.count) }], details: {} };
        },
      });
      pi.on("tool_call", (event) => {
        calls.push(event.toolCallId);
        if (event.toolCallId === "blocked") return { block: true, reason: "fixture gate" };
      });
      pi.on("tool_result", (event) => { results.push(event.toolCallId); });
      pi.on("tool_execution_end", (event) => { ended.push({ id: event.toolCallId, isError: event.isError }); });
    }, [[
      { type: "toolCall", id: "invalid", name: "checked", arguments: { count: "not-numeric" } },
      { type: "toolCall", id: "unknown", name: "missing_tool", arguments: {} },
      { type: "toolCall", id: "blocked", name: "checked", arguments: { count: 2 } },
      { type: "toolCall", id: "thrown", name: "checked", arguments: { count: 3 } },
      { type: "toolCall", id: "coerced", name: "checked", arguments: { count: "4" } },
    ]]);
    const session = await f.open(SessionManager.inMemory(f.root));
    await session.prompt("exercise calls");
    expect(calls).toEqual(["blocked", "thrown", "coerced"]);
    expect(executed.sort()).toEqual([3, 4]);
    expect(results).toContain("coerced");
    expect(results).not.toContain("invalid");
    expect(results).not.toContain("unknown");
    expect(results).not.toContain("blocked");
    expect(ended).toHaveLength(5);
    expect(Object.fromEntries(ended.map(({ id, isError }) => [id, isError]))).toEqual({
      invalid: true, unknown: true, blocked: true, thrown: true, coerced: false,
    });
    const failures = session.messages.filter((message) => message.role === "toolResult" && message.isError);
    expect(failures).toHaveLength(4);
    expect(JSON.stringify(failures)).toContain("fixture execution failure");
    expect(JSON.stringify(failures)).toContain("fixture gate");
    expect(f.requests).toHaveLength(2);
  });

  it("sends Pi's identity as a separate preamble section that Claude Agent can drop", async () => {
    const f = await fixture(() => {});
    const session = await f.open(SessionManager.inMemory(f.root));
    await session.prompt("hello");
    const instructions = piInstructions(f.requests[0]!.messages);
    expect(instructions).not.toContain("You are a coding assistant running inside pi");
    expect(instructions).toContain("<rules>");
    expect(instructions).toContain("<cwd>");
  });

  it("distinguishes user (including images) and custom-message runs before agent start", async () => {
    const starts: unknown[] = [];
    const f = await fixture((pi) => {
      pi.on("before_agent_start", (event) => {
        starts.push(structuredClone(event));
        return { message: { customType: "contract-context", content: "injected context", display: false } };
      });
    });
    const session = await f.open(SessionManager.inMemory(f.root));
    const images = [{ type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" }];
    await session.prompt("user input", { images });
    await session.sendCustomMessage({ customType: "contract-trigger", content: "custom input", display: false }, { triggerTurn: true });
    await session.waitForIdle();
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ messageType: "user", prompt: "user input", images });
    expect(starts[1]).toMatchObject({ messageType: "custom", message: { customType: "contract-trigger", content: "custom input" } });
    expect(starts[1]).not.toHaveProperty("prompt");
    expect(session.messages.filter((message) => message.role === "custom" && message.customType === "contract-context")).toHaveLength(2);
    expect(f.requests).toHaveLength(2);
  });

  it("natively retains explicitly activated inactive tools across reload and session reopen", async () => {
    const f = await fixture((pi) => {
      for (const name of ["first", "second"]) pi.registerTool({
        name, label: name, description: name, defaultActive: false, parameters: Type.Object({}),
        async execute() { return { content: [{ type: "text", text: name }], details: {} }; },
      });
    });
    const manager = SessionManager.create(f.root, join(f.root, "sessions"));
    const session = await f.open(manager);
    session.setActiveToolsByName(["second"]);
    await session.prompt("persist loadout");
    expect(getCurrentTools(f.requests[0].messages).map((tool) => tool.name)).toEqual(["second"]);
    await session.reload();
    expect(session.getActiveToolNames()).toEqual(["second"]);
    await session.prompt("after reload");
    expect(getCurrentTools(f.requests[1].messages).map((tool) => tool.name)).toEqual(["second"]);
    const sessionFile = session.sessionFile!;
    session.dispose();
    const restored = await f.open(SessionManager.open(sessionFile));
    expect(restored.getActiveToolNames()).toEqual(["second"]);
    await restored.prompt("after restore");
    expect(getCurrentTools(f.requests[2].messages).map((tool) => tool.name)).toEqual(["second"]);
  });
});
