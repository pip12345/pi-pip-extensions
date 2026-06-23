import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { createMockCtx, createMockPi, emitEvent, getRegisteredShortcut, getRegisteredTool, runCommand } from "../pip-common/testing.ts";
import { addUsage, flushPipTools, pipSettings, resetPipToolsForTests, type TokenUsage } from "../pip-common/index.ts";
import { createSubagentsExtension, resetManagerForTests } from "./index.ts";
import { SubagentManager } from "./src/manager.ts";
import { SubagentViewer } from "./src/view.ts";
import { RealRunner } from "./src/runner.ts";
import type { ChildAgentRuntime } from "./src/child-runtime.ts";
import type { Runner, SubagentRun } from "./src/types.ts";

class FakeRunner implements Runner {
  delay = 0;
  failContinue = false;
  usage?: TokenUsage;
  launched: SubagentRun[] = [];
  inputs: any[] = [];
  async launch(input: any, run: SubagentRun): Promise<SubagentRun> {
    this.launched.push(run);
    this.inputs.push(input);
    run.sessionFile = `/tmp/${run.id}.json`;
    if (this.usage) addUsage(run.usage, this.usage);
    run.dispose = () => undefined;
    run.cancel = async () => {
      run.abortController.abort();
      run.status = "cancelled";
    };
    run.steer = async (message: string, displayMessage?: string) => {
      run.events.push({ type: "text_delta", text: displayMessage ?? message, at: Date.now() });
    };
    run.continuePrompt = async (prompt: string) => {
      if (this.failContinue) throw new Error("continue failed");
      run.resultText = `continued: ${prompt}`;
    };
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    if (run.status === "cancelled") return run;
    run.resultText = `done: ${input.prompt}`;
    run.status = "completed";
    run.completedAt = Date.now();
    return run;
  }
}

class UsageRuntime implements ChildAgentRuntime {
  async create(_input: any, _sessionDir: string) {
    let subscriber: ((event: any) => void) | undefined;
    const session = {
      sessionFile: "/tmp/child-session.jsonl",
      isStreaming: false,
      subscribe(cb: (event: any) => void) {
        subscriber = cb;
        return () => { subscriber = undefined; };
      },
      async prompt() {
        subscriber?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "child done" }],
            usage: { input: 172_000, output: 6_000, cacheRead: 848_000, cost: { total: 0.42 } },
          },
        });
      },
      async abort() {},
      dispose() {},
      async sendUserMessage() {},
      getActiveToolNames: () => [],
      setActiveToolsByName() {},
      async setModel() {},
    };
    return { session: session as any, modelRegistry: { find: () => ({}) } as any };
  }
}

class ModelRuntime implements ChildAgentRuntime {
  findCalls: Array<[string, string]> = [];
  setModels: any[] = [];
  constructor(private readonly found = true) {}

  async create(_input: any, _sessionDir: string) {
    let subscriber: ((event: any) => void) | undefined;
    const model = { provider: "openrouter", id: "anthropic/claude-sonnet-4" };
    const runtime = this;
    const session = {
      sessionFile: "/tmp/model-session.jsonl",
      isStreaming: false,
      subscribe(cb: (event: any) => void) {
        subscriber = cb;
        return () => { subscriber = undefined; };
      },
      async prompt() {
        subscriber?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "child done" }], usage: { input: 1, output: 1 } } });
      },
      async abort() {},
      dispose() {},
      async sendUserMessage() {},
      getActiveToolNames: () => [],
      setActiveToolsByName() {},
      async setModel(selected: any) { runtime.setModels.push(selected); },
    };
    return {
      session: session as any,
      modelRegistry: {
        find(provider: string, id: string) {
          runtime.findCalls.push([provider, id]);
          return runtime.found && provider === model.provider && id === model.id ? model : undefined;
        },
      } as any,
    };
  }
}

function setup(runner: Runner = new FakeRunner()) {
  const pi = createMockPi();
  createSubagentsExtension({ runner })(pi as any);
  flushPipTools(pi as any);
  return { pi, runner, tool: getRegisteredTool(pi, "subagent") };
}

function persistedSetup(runner: Runner = new FakeRunner()) {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
  const manager = new SubagentManager({ runner, persistenceDir: dir });
  const pi = createMockPi();
  createSubagentsExtension({ manager })(pi as any);
  flushPipTools(pi as any);
  return { dir, manager, pi, runner, tool: getRegisteredTool(pi, "subagent"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function ctxForSession(sessionFile: string, cwd = process.cwd(), leafId?: string, branchIds?: string[]) {
  return createMockCtx({
    cwd,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionFile,
      getLeafId: () => leafId,
      getBranch: () => (branchIds ?? (leafId ? [leafId] : [])).map((id) => ({ id })),
    },
  });
}

beforeEach(() => {
  resetPipToolsForTests();
  resetManagerForTests();
  pipSettings.set("subagents.enabled", true);
  pipSettings.set("subagents.injectBackgroundResults", true);
  pipSettings.set("subagents.alwaysKeep", false);
  pipSettings.set("subagents.showUsageCost", true);
});

describe("pi-subagents", () => {
  it("registers tool, command, shortcut, and prompt metadata", () => {
    const { pi, tool } = setup();
    expect(tool).toBeTruthy();
    expect(tool.promptSnippet).toContain("subagent");
    expect(tool.promptGuidelines.join("\n")).toContain("model is a launch-only override");
    expect(tool.promptGuidelines.join("\n")).toContain("action:'models'");
    expect(tool.promptGuidelines.join("\n")).toContain("Do not repeatedly poll");
    expect(pi.commands.has("subagent")).toBe(true);
    expect(getRegisteredShortcut(pi, "ctrl+shift+b")).toBeTruthy();
  });

  it("injects available agent names into the prompt", async () => {
    const { pi } = setup();
    const [result] = await emitEvent(pi, "before_agent_start", { systemPrompt: "base" }, createMockCtx());
    expect(result.systemPrompt).toContain("base");
    expect(result.systemPrompt).toContain("Available subagent agents:");
    expect(result.systemPrompt).toContain("explore");
    expect(result.systemPrompt).toContain("general");
  });

  it("does not inject available agent names when subagents are disabled", async () => {
    pipSettings.set("subagents.enabled", false);
    const { pi } = setup();
    const [result] = await emitEvent(pi, "before_agent_start", { systemPrompt: "base" }, createMockCtx());
    expect(result).toBeUndefined();
  });

  it("injects project agent names from the current workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagents-project-agents-"));
    try {
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(join(dir, ".pi", "agents", "reviewer.md"), "---\ndescription: Reviews code changes\n---\n\nReview code.");
      const { pi } = setup();
      const [result] = await emitEvent(pi, "before_agent_start", { systemPrompt: "base" }, createMockCtx({ cwd: dir }));
      expect(result.systemPrompt).toContain("Available subagent agents:");
      expect(result.systemPrompt).toContain("reviewer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists built-in agents and returns agent details", async () => {
    const { tool } = setup();
    const ctx = createMockCtx();
    const listed = await tool.execute("1", { action: "agents" }, undefined, undefined, ctx);
    expect(listed.content[0].text).toContain("explore");
    expect(listed.content[0].text).toContain(".pi/agents");
    const detail = await tool.execute("1", { action: "get_agent", agent: "explore" }, undefined, undefined, ctx);
    expect(detail.content[0].text).toContain("agent: explore");
    expect(detail.content[0].text).toContain("tools:");
  });

  it("lists available launch model override ids for the agent", async () => {
    const { tool } = setup();
    const ctx = createMockCtx();
    let refreshed = false;
    ctx.modelRegistry = {
      refresh: () => { refreshed = true; },
      getAvailable: () => [
        { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4", api: "openai-codex-responses" },
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", api: "anthropic-messages" },
      ],
      getError: () => undefined,
    };

    const result = await tool.execute("1", { action: "models", query: "codex 5.4" }, undefined, undefined, ctx);
    expect(refreshed).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Available subagent models matching \"codex 5.4\" (1/2)");
    expect(result.content[0].text).toContain("openai-codex/gpt-5.4 — GPT-5.4");
    expect(result.content[0].text).not.toContain("anthropic/claude-sonnet-4-5");
    expect(result.details.models).toEqual([{ id: "openai-codex/gpt-5.4", name: "GPT-5.4" }]);
  });

  it("passes launch model overrides without new agent files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagents-model-"));
    const runner = new FakeRunner();
    const { tool } = setup(runner);
    try {
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(join(dir, ".pi", "agents", "fixed.md"), "---\ndescription: Has a fixed model\nmodel: openai/gpt-old\n---\n\nUse the configured model unless overridden.");
      const ctx = createMockCtx({ cwd: dir, model: { provider: "openai", id: "gpt-parent" } });

      const overridden = await tool.execute("1", { agent: "fixed", prompt: "use override", model: "openrouter/anthropic/claude-sonnet-4" }, undefined, undefined, ctx);
      expect(overridden.isError).toBeFalsy();
      expect(overridden.content[0].text).toContain("model: openrouter/anthropic/claude-sonnet-4");
      expect(overridden.details.run.model).toBe("openrouter/anthropic/claude-sonnet-4");
      expect(runner.inputs[0].agent.model).toBe("openai/gpt-old");
      expect(runner.inputs[0].model).toBe("openrouter/anthropic/claude-sonnet-4");

      const inherited = await tool.execute("2", { agent: "explore", prompt: "inherit current" }, undefined, undefined, ctx);
      expect(inherited.isError).toBeFalsy();
      expect(inherited.content[0].text).toContain("model: openai/gpt-parent");
      expect(inherited.details.run.model).toBe("openai/gpt-parent");
      expect(runner.inputs[1].model).toBe("openai/gpt-parent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects model overrides outside launch", async () => {
    const { tool } = setup();
    const ctx = createMockCtx();
    const result = await tool.execute("1", { action: "status", id: "missing", model: "openai/gpt-5.1" }, undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("only supported when launching");

    const launched = await tool.execute("2", { agent: "explore", prompt: "one" }, undefined, undefined, ctx);
    const id = launched.content[0].text.match(/subagent_id: (\S+)/)?.[1];
    const ignoredContinuationOverride = await tool.execute("3", { action: "launch", id, prompt: "again", model: "openai/gpt-5.1" }, undefined, undefined, ctx);
    expect(ignoredContinuationOverride.isError).toBe(true);
    expect(ignoredContinuationOverride.content[0].text).toContain("only supported when launching");
  });

  it("rejects malformed launch model overrides", async () => {
    const { tool } = setup();
    const ctx = createMockCtx({ model: { provider: "openai", id: "gpt-parent" } });
    for (const model of ["gpt-5.1", "/gpt-5.1", "openai/", " openai/gpt-5.1", "openai/gpt 5.1"]) {
      const result = await tool.execute("1", { agent: "explore", prompt: "bad", model }, undefined, undefined, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("provider/model-id");
    }
  });

  it("runs foreground subagents and allows ephemeral continuation while retained", async () => {
    const { tool } = setup();
    const ctx = createMockCtx();
    const result = await tool.execute("1", { agent: "explore", prompt: "look around" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("state: completed");
    const id = result.content[0].text.match(/subagent_id: (\S+)/)?.[1];
    const continued = await tool.execute("2", { id, prompt: "again" }, undefined, undefined, ctx);
    expect(continued.isError).toBeFalsy();
    expect(continued.content[0].text).toContain("continued: again");
  });

  it("real runner parses slash-containing model ids and sets the child model", async () => {
    const runtime = new ModelRuntime();
    const runner = new RealRunner(runtime);
    const { tool } = setup(runner);
    const result = await tool.execute("1", { agent: "explore", prompt: "model", model: "openrouter/anthropic/claude-sonnet-4" }, undefined, undefined, createMockCtx());
    expect(result.isError).toBeFalsy();
    expect(runtime.findCalls).toEqual([["openrouter", "anthropic/claude-sonnet-4"]]);
    expect(runtime.setModels).toEqual([{ provider: "openrouter", id: "anthropic/claude-sonnet-4" }]);
  });

  it("real runner unknown model errors point to model discovery", async () => {
    const runner = new RealRunner(new ModelRuntime(false));
    const { tool } = setup(runner);
    const result = await tool.execute("1", { agent: "explore", prompt: "model", model: "openrouter/anthropic/claude-sonnet-4" }, undefined, undefined, createMockCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown subagent model: openrouter/anthropic/claude-sonnet-4");
    expect(result.content[0].text).toContain("action: \"models\"");
    expect(result.content[0].text).toContain('query: "openrouter"');
  });

  it("accumulates real child assistant usage and renders compact usage with cost", async () => {
    const runner = new RealRunner(new UsageRuntime());
    const { tool } = setup(runner);
    const ctx = createMockCtx();
    const result = await tool.execute("1", { agent: "explore", prompt: "usage", model: "openai-codex/gpt-5.4" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("model: openai-codex/gpt-5.4");
    expect(result.content[0].text).toContain("usage: ↓:172k ↑:6k ↻:848k · $0.42");
    expect(result.details.run.usage).toMatchObject({ input: 172_000, output: 6_000, cache: 848_000, cost: 0.42 });
    const rendered = tool.renderResult(result, { expanded: false }, { fg: (_key: string, text: string) => text }).render(120).join("\n");
    expect(rendered).toContain("openai-codex/gpt-5.4");
    expect(rendered).toContain("↓:172k ↑:6k ↻:848k · $0.42");
  });

  it("can hide subagent usage cost", async () => {
    pipSettings.set("subagents.showUsageCost", false);
    const runner = new FakeRunner();
    runner.usage = { input: 172_000, output: 6_000, cacheRead: 848_000, cacheWrite: 0, cache: 848_000, total: 1_026_000, cost: 0.42 };
    const { tool } = setup(runner);
    const result = await tool.execute("1", { agent: "explore", prompt: "usage no cost" }, undefined, undefined, createMockCtx());
    expect(result.content[0].text).toContain("usage: ↓:172k ↑:6k ↻:848k");
    expect(result.content[0].text).not.toContain("$0.42");
  });

  it("persists usage for retained subagents", async () => {
    const parentFile = join(mkdtempSync(join(tmpdir(), "pi-parent-usage-")), "parent.jsonl");
    writeFileSync(parentFile, "{}\n");
    const runner = new FakeRunner();
    runner.usage = { input: 172_000, output: 6_000, cacheRead: 848_000, cacheWrite: 0, cache: 848_000, total: 1_026_000, cost: 0.42 };
    const first = persistedSetup(runner);
    try {
      const ctx = ctxForSession(parentFile);
      const launched = await first.tool.execute("1", { agent: "explore", prompt: "persist usage", keep: true, name: "usage-run" }, undefined, undefined, ctx);
      expect(launched.content[0].text).toContain("usage: ↓:172k ↑:6k ↻:848k · $0.42");
      const secondManager = new SubagentManager({ runner: new FakeRunner(), persistenceDir: first.dir });
      const secondPi = createMockPi();
      createSubagentsExtension({ manager: secondManager })(secondPi as any);
      flushPipTools(secondPi as any);
      const secondTool = getRegisteredTool(secondPi, "subagent");
      const restored = await secondTool.execute("2", { action: "status", id: "usage-run" }, undefined, undefined, ctx);
      expect(restored.content[0].text).toContain("usage: ↓:172k ↑:6k ↻:848k · $0.42");
    } finally {
      first.cleanup();
      rmSync(dirname(parentFile), { recursive: true, force: true });
    }
  });

  it("kept subagents can be continued", async () => {
    const { tool } = setup();
    const ctx = createMockCtx();
    const result = await tool.execute("1", { agent: "explore", prompt: "look", keep: true, name: "scout" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("keep: true");
    const continued = await tool.execute("2", { id: "scout", prompt: "again" }, undefined, undefined, ctx);
    expect(continued.isError).toBeFalsy();
    expect(continued.content[0].text).toContain("continued: again");
  });

  it("persists subagent model metadata", async () => {
    const parentFile = join(mkdtempSync(join(tmpdir(), "pi-parent-model-")), "parent.jsonl");
    writeFileSync(parentFile, "{}\n");
    const first = persistedSetup();
    try {
      const ctx = ctxForSession(parentFile);
      await first.tool.execute("1", { agent: "explore", prompt: "model metadata", keep: true, name: "model-run", model: "openai-codex/gpt-5.4" }, undefined, undefined, ctx);
      const secondManager = new SubagentManager({ runner: new FakeRunner(), persistenceDir: first.dir });
      const secondPi = createMockPi();
      createSubagentsExtension({ manager: secondManager })(secondPi as any);
      flushPipTools(secondPi as any);
      await emitEvent(secondPi, "session_start", {}, ctx);
      const secondTool = getRegisteredTool(secondPi, "subagent");
      const restored = await secondTool.execute("2", { action: "status", id: "model-run" }, undefined, undefined, ctx);
      expect(restored.content[0].text).toContain("model: openai-codex/gpt-5.4");
      expect(restored.details.run.model).toBe("openai-codex/gpt-5.4");
      const listed = await secondTool.execute("3", {}, undefined, undefined, ctx);
      expect(listed.content[0].text).toContain("explore openai-codex/gpt-5.4");
    } finally {
      first.cleanup();
      rmSync(dirname(parentFile), { recursive: true, force: true });
    }
  });

  it("persists kept subagents and restores them for the same parent", async () => {
    const parentFile = join(mkdtempSync(join(tmpdir(), "pi-parent-")), "parent.jsonl");
    writeFileSync(parentFile, "{}\n");
    const first = persistedSetup();
    try {
      const ctx = ctxForSession(parentFile);
      const launched = await first.tool.execute("1", { agent: "explore", prompt: "persist me", keep: true, name: "persisted" }, undefined, undefined, ctx);
      expect(launched.content[0].text).toContain("keep: true");
      const secondRunner = new FakeRunner();
      const secondManager = new SubagentManager({ runner: secondRunner, persistenceDir: first.dir });
      const secondPi = createMockPi();
      createSubagentsExtension({ manager: secondManager })(secondPi as any);
      flushPipTools(secondPi as any);
      const secondTool = getRegisteredTool(secondPi, "subagent");
      await emitEvent(secondPi, "session_start", {}, ctx);
      const list = await secondTool.execute("2", {}, undefined, undefined, ctx);
      expect(list.content[0].text).toContain("persisted");
      expect(list.content[0].text).toContain("persist me");
    } finally {
      first.cleanup();
      rmSync(dirname(parentFile), { recursive: true, force: true });
    }
  });

  it("ephemeral subagents persist on the same branch and prune when anchored off-branch", async () => {
    const parentFile = join(mkdtempSync(join(tmpdir(), "pi-parent-")), "parent.jsonl");
    writeFileSync(parentFile, "{}\n");
    const first = persistedSetup();
    try {
      const ctx = ctxForSession(parentFile, process.cwd(), "m1", ["root", "m1"]);
      const launched = await first.tool.execute("1", { agent: "explore", prompt: "ephemeral" }, undefined, undefined, ctx);
      const id = launched.content[0].text.match(/subagent_id: (\S+)/)?.[1];

      const secondManager = new SubagentManager({ runner: new FakeRunner(), persistenceDir: first.dir });
      const secondPi = createMockPi();
      createSubagentsExtension({ manager: secondManager })(secondPi as any);
      flushPipTools(secondPi as any);
      const secondTool = getRegisteredTool(secondPi, "subagent");

      await emitEvent(secondPi, "session_start", {}, ctx);
      const sameBranch = await secondTool.execute("2", {}, undefined, undefined, ctx);
      expect(sameBranch.content[0].text).toContain("ephemeral");
      const continued = await secondTool.execute("2b", { id, prompt: "again" }, undefined, undefined, ctx);
      expect(continued.isError).toBeFalsy();
      expect(continued.content[0].text).toContain("done: again");

      const otherBranch = ctxForSession(parentFile, process.cwd(), "m0", ["root", "m0"]);
      await emitEvent(secondPi, "session_start", {}, otherBranch);
      const hidden = await secondTool.execute("3", { action: "status", id }, undefined, undefined, otherBranch);
      expect(hidden.isError).toBe(true);
      const listed = await secondTool.execute("4", {}, undefined, undefined, otherBranch);
      expect(listed.content[0].text).toBe("No retained subagents.");
    } finally {
      first.cleanup();
      rmSync(dirname(parentFile), { recursive: true, force: true });
    }
  });

  it("kept subagents are hidden off-branch but not pruned", async () => {
    const parentFile = join(mkdtempSync(join(tmpdir(), "pi-parent-")), "parent.jsonl");
    writeFileSync(parentFile, "{}\n");
    const first = persistedSetup();
    try {
      const ctx = ctxForSession(parentFile, process.cwd(), "m1", ["root", "m1"]);
      await first.tool.execute("1", { agent: "explore", prompt: "kept branch", keep: true, name: "branchy" }, undefined, undefined, ctx);
      const secondManager = new SubagentManager({ runner: new FakeRunner(), persistenceDir: first.dir });
      const secondPi = createMockPi();
      createSubagentsExtension({ manager: secondManager })(secondPi as any);
      flushPipTools(secondPi as any);
      const secondTool = getRegisteredTool(secondPi, "subagent");

      const otherBranch = ctxForSession(parentFile, process.cwd(), "m0", ["root", "m0"]);
      await emitEvent(secondPi, "session_start", {}, otherBranch);
      const hidden = await secondTool.execute("2", {}, undefined, undefined, otherBranch);
      expect(hidden.content[0].text).toBe("No retained subagents.");

      await emitEvent(secondPi, "session_start", {}, ctx);
      const visible = await secondTool.execute("3", {}, undefined, undefined, ctx);
      expect(visible.content[0].text).toContain("branchy");
    } finally {
      first.cleanup();
      rmSync(dirname(parentFile), { recursive: true, force: true });
    }
  });

  it("running ephemeral subagents restore as interrupted and can be continued", async () => {
    const parentFile = join(mkdtempSync(join(tmpdir(), "pi-parent-")), "parent.jsonl");
    writeFileSync(parentFile, "{}\n");
    const runner = new FakeRunner();
    runner.delay = 100;
    const first = persistedSetup(runner);
    try {
      const ctx = ctxForSession(parentFile, process.cwd(), "m1", ["root", "m1"]);
      await first.tool.execute("1", { agent: "explore", prompt: "running", background: true }, undefined, undefined, ctx);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await first.manager.shutdown();

      const secondRunner = new FakeRunner();
      const secondManager = new SubagentManager({ runner: secondRunner, persistenceDir: first.dir });
      const secondPi = createMockPi();
      createSubagentsExtension({ manager: secondManager })(secondPi as any);
      flushPipTools(secondPi as any);
      const secondTool = getRegisteredTool(secondPi, "subagent");
      await emitEvent(secondPi, "session_start", {}, ctx);
      const listed = await secondTool.execute("2", {}, undefined, undefined, ctx);
      expect(listed.content[0].text).toContain("[interrupted");
      const id = listed.content[0].text.match(/^(sa_\S+)/)?.[1];
      const continued = await secondTool.execute("3", { id, prompt: "resume" }, undefined, undefined, ctx);
      expect(continued.isError).toBeFalsy();
      expect(continued.content[0].text).toContain("done: resume");
    } finally {
      first.cleanup();
      rmSync(dirname(parentFile), { recursive: true, force: true });
    }
  });

  it("restored kept subagents are parent-local and continuable", async () => {
    const parentA = join(mkdtempSync(join(tmpdir(), "pi-parent-a-")), "parent.jsonl");
    const parentB = join(mkdtempSync(join(tmpdir(), "pi-parent-b-")), "parent.jsonl");
    writeFileSync(parentA, "{}\n");
    writeFileSync(parentB, "{}\n");
    const first = persistedSetup();
    try {
      const ctxA = ctxForSession(parentA);
      const ctxB = ctxForSession(parentB);
      await first.tool.execute("1", { agent: "explore", prompt: "continue me", keep: true, name: "keep-a" }, undefined, undefined, ctxA);

      const secondRunner = new FakeRunner();
      const secondManager = new SubagentManager({ runner: secondRunner, persistenceDir: first.dir });
      const secondPi = createMockPi();
      createSubagentsExtension({ manager: secondManager })(secondPi as any);
      flushPipTools(secondPi as any);
      const secondTool = getRegisteredTool(secondPi, "subagent");

      await emitEvent(secondPi, "session_start", {}, ctxA);
      const restored = await secondTool.execute("2", {}, undefined, undefined, ctxA);
      expect(restored.content[0].text).toContain("keep-a");

      await emitEvent(secondPi, "session_start", {}, ctxB);
      const otherParentList = await secondTool.execute("3", {}, undefined, undefined, ctxB);
      expect(otherParentList.content[0].text).toBe("No retained subagents.");
      const runId = secondManager.list(parentA)[0]?.id ?? "missing";
      const crossReadByName = await secondTool.execute("4", { action: "status", id: "keep-a" }, undefined, undefined, ctxB);
      expect(crossReadByName.isError).toBe(true);
      const crossReadById = await secondTool.execute("5", { action: "status", id: runId }, undefined, undefined, ctxB);
      expect(crossReadById.isError).toBe(true);

      await emitEvent(secondPi, "session_start", {}, ctxA);
      const continued = await secondTool.execute("6", { id: "keep-a", prompt: "again" }, undefined, undefined, ctxA);
      expect(continued.isError).toBeFalsy();
      expect(continued.content[0].text).toContain("done: again");
      expect(secondRunner.launched.length).toBe(1);
      expect((secondRunner.launched as any)[0]).toBeTruthy();
    } finally {
      first.cleanup();
      rmSync(dirname(parentA), { recursive: true, force: true });
      rmSync(dirname(parentB), { recursive: true, force: true });
    }
  });

  it("forget makes a kept subagent ephemeral and keeps it persisted while relevant", async () => {
    const parentFile = join(mkdtempSync(join(tmpdir(), "pi-parent-")), "parent.jsonl");
    writeFileSync(parentFile, "{}\n");
    const first = persistedSetup();
    try {
      const ctx = ctxForSession(parentFile);
      const launched = await first.tool.execute("1", { agent: "explore", prompt: "forget me", keep: true, name: "forgotten" }, undefined, undefined, ctx);
      const id = launched.content[0].text.match(/subagent_id: (\S+)/)?.[1];
      const forgot = await first.tool.execute("2", { action: "forget", id: "forgotten" }, undefined, undefined, ctx);
      expect(forgot.content[0].text).toContain("ephemeral now");
      const sameSessionStatus = await first.tool.execute("2b", { action: "status", id }, undefined, undefined, ctx);
      expect(sameSessionStatus.content[0].text).toContain("keep: false");
      const secondManager = new SubagentManager({ runner: new FakeRunner(), persistenceDir: first.dir });
      const secondPi = createMockPi();
      createSubagentsExtension({ manager: secondManager })(secondPi as any);
      flushPipTools(secondPi as any);
      await emitEvent(secondPi, "session_start", {}, ctx);
      const list = await getRegisteredTool(secondPi, "subagent").execute("3", {}, undefined, undefined, ctx);
      expect(list.content[0].text).toContain("forgotten");
      expect(list.content[0].text).toContain("[completed");
    } finally {
      first.cleanup();
      rmSync(dirname(parentFile), { recursive: true, force: true });
    }
  });

  it("deleting parent session lazily removes persisted kept subagents", async () => {
    const parentFile = join(mkdtempSync(join(tmpdir(), "pi-parent-")), "parent.jsonl");
    const otherParent = join(mkdtempSync(join(tmpdir(), "pi-parent-other-")), "parent.jsonl");
    writeFileSync(parentFile, "{}\n");
    writeFileSync(otherParent, "{}\n");
    const first = persistedSetup();
    try {
      const parentCtx = ctxForSession(parentFile);
      await first.tool.execute("1", { agent: "explore", prompt: "orphan", keep: true, name: "orphan" }, undefined, undefined, parentCtx);
      await emitEvent(first.pi, "session_start", {}, parentCtx);
      expect(first.manager.list(parentFile).length).toBe(1);
      rmSync(parentFile, { force: true });
      await emitEvent(first.pi, "session_start", {}, parentCtx);
      expect(first.manager.list(parentFile).length).toBe(0);
      const secondManager = new SubagentManager({ runner: new FakeRunner(), persistenceDir: first.dir });
      const secondPi = createMockPi();
      createSubagentsExtension({ manager: secondManager })(secondPi as any);
      flushPipTools(secondPi as any);
      const ctx = ctxForSession(otherParent);
      await emitEvent(secondPi, "session_start", {}, ctx);
      const orphanCtx = ctxForSession(parentFile);
      const list = await getRegisteredTool(secondPi, "subagent").execute("2", {}, undefined, undefined, orphanCtx);
      expect(list.content[0].text).toBe("No retained subagents.");
    } finally {
      first.cleanup();
      rmSync(dirname(parentFile), { recursive: true, force: true });
      rmSync(dirname(otherParent), { recursive: true, force: true });
    }
  });

  it("failed kept continuation cleans up running state", async () => {
    const runner = new FakeRunner();
    runner.failContinue = true;
    const { tool } = setup(runner);
    const ctx = createMockCtx();
    await tool.execute("1", { agent: "explore", prompt: "look", keep: true, name: "bad-continue" }, undefined, undefined, ctx);
    const failed = await tool.execute("2", { id: "bad-continue", prompt: "again" }, undefined, undefined, ctx);
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain("continue failed");
    const status = await tool.execute("3", { action: "status", id: "bad-continue" }, undefined, undefined, ctx);
    expect(status.content[0].text).toContain("state: error");
  });

  it("adds handoff workspace paths and guidance to launched prompts", async () => {
    const runner = new FakeRunner();
    const contextDir = mkdtempSync(join(tmpdir(), "pi-subagent-context-"));
    const manager = new SubagentManager({ runner, contextDir });
    const agent = { name: "explore", description: "", systemPrompt: "", tools: undefined, source: "test", filePath: "test" } as any;
    try {
      const run = manager.launch({ agent, prompt: "inspect auth", cwd: process.cwd(), parentSessionKey: "parent", keep: false, background: false });
      await run.runPromise;
      expect(run.contextRoot).toContain(contextDir);
      expect(run.runContextDir).toContain(run.id);
      expect(runner.inputs[0].prompt).toContain("<subagent_handoff_workspace>");
      expect(runner.inputs[0].prompt).toContain(run.runContextDir);
      expect(runner.inputs[0].prompt).toContain("Use chat for the direct answer");
      const snapshot = manager.snapshot(run);
      expect(snapshot.contextRoot).toBe(run.contextRoot);
      expect(snapshot.runContextDir).toBe(run.runContextDir);
    } finally {
      rmSync(contextDir, { recursive: true, force: true });
    }
  });

  it("removes unkept run context on cleanup", async () => {
    pipSettings.set("subagents.ephemeralTtlMinutes", 1);
    let now = 0;
    const contextDir = mkdtempSync(join(tmpdir(), "pi-subagent-context-"));
    const manager = new SubagentManager({ runner: new FakeRunner(), now: () => now, contextDir });
    const agent = { name: "explore", description: "", systemPrompt: "", tools: undefined, source: "test", filePath: "test" } as any;
    try {
      const run = manager.launch({ agent, prompt: "one", cwd: process.cwd(), parentSessionKey: "parent", keep: false, background: false });
      await run.runPromise;
      mkdirSync(run.runContextDir!, { recursive: true });
      writeFileSync(join(run.runContextDir!, "artifact.md"), "details");
      expect(existsSync(run.runContextDir!)).toBe(true);
      now = 61_000;
      manager.cleanup("parent");
      expect(manager.resolve(run.id, "parent")).toBeUndefined();
      expect(existsSync(run.runContextDir!)).toBe(false);
    } finally {
      rmSync(contextDir, { recursive: true, force: true });
    }
  });

  it("/subagent delete confirms and deletes a completed run", async () => {
    const { tool, pi } = setup();
    const ctx = createMockCtx({ confirm: true });
    const result = await tool.execute("1", { agent: "explore", prompt: "delete me", keep: true, name: "trash" }, undefined, undefined, ctx);
    const id = result.content[0].text.match(/subagent_id: (\S+)/)?.[1];
    await runCommand(pi, "subagent", `delete ${id}`, ctx);
    expect(ctx.ui.notifications.at(-1)?.message).toContain(`Deleted ${id}`);
    const list = await tool.execute("2", {}, undefined, undefined, ctx);
    expect(list.content[0].text).not.toContain(id);
  });

  it("subagent viewer deletes with ctrl+d then enter", async () => {
    const manager = new SubagentManager({ runner: new FakeRunner() });
    const agent = { name: "explore", description: "", systemPrompt: "", tools: undefined, source: "test", filePath: "test" } as any;
    const run = manager.launch({ agent, prompt: "view delete", cwd: process.cwd(), parentSessionKey: "parent", keep: true, background: false });
    await run.runPromise;
    let closed = false;
    const viewer = new SubagentViewer({ requestRender: () => undefined }, {}, () => { closed = true; }, { sessionManager: { getSessionFile: () => "parent" } }, manager, run.id);
    viewer.handleInput("\u0004");
    expect(manager.resolve(run.id, "parent")).toBeTruthy();
    viewer.handleInput("\r");
    expect(manager.resolve(run.id, "parent")).toBeUndefined();
    expect(closed).toBe(true);
    viewer.dispose();
  });

  it("/subagent context shows workspace paths", async () => {
    const runner = new FakeRunner();
    const contextDir = mkdtempSync(join(tmpdir(), "pi-subagent-context-"));
    const manager = new SubagentManager({ runner, contextDir });
    const pi = createMockPi();
    createSubagentsExtension({ manager })(pi as any);
    flushPipTools(pi as any);
    const ctx = createMockCtx();
    try {
      const tool = getRegisteredTool(pi, "subagent");
      const result = await tool.execute("1", { agent: "explore", prompt: "ctx", keep: true, name: "ctx-run" }, undefined, undefined, ctx);
      const id = result.content[0].text.match(/subagent_id: (\S+)/)?.[1];
      await runCommand(pi, "subagent", "context", ctx);
      expect(ctx.ui.notifications.at(-1)?.message).toContain("Subagent context root");
      await runCommand(pi, "subagent", `context ${id}`, ctx);
      expect(ctx.ui.notifications.at(-1)?.message).toContain(`Subagent context: ${id}`);
      expect(ctx.ui.notifications.at(-1)?.message).toContain("Run folder:");
    } finally {
      rmSync(contextDir, { recursive: true, force: true });
    }
  });

  it("message and steer refresh ephemeral TTL", async () => {
    pipSettings.set("subagents.ephemeralTtlMinutes", 1);
    let now = 0;
    const manager = new SubagentManager({ runner: new FakeRunner(), now: () => now });
    const agent = { name: "explore", description: "", systemPrompt: "", tools: undefined, source: "test", filePath: "test" } as any;
    const run = manager.launch({ agent, prompt: "one", cwd: process.cwd(), parentSessionKey: "parent", keep: false, background: false });
    await run.runPromise;

    now = 50_000;
    await manager.continueRun(run, "two", agent);
    now = 105_000;
    manager.cleanup("parent");
    expect(manager.resolve(run.id, "parent")).toBeTruthy();

    now = 110_000;
    await manager.steer(run, "three", agent);
    now = 169_000;
    manager.cleanup("parent");
    expect(manager.resolve(run.id, "parent")).toBeTruthy();

    now = 171_000;
    manager.cleanup("parent");
    expect(manager.resolve(run.id, "parent")).toBeUndefined();
  });

  it("alwaysKeep makes new subagents reusable unless keep false", async () => {
    pipSettings.set("subagents.alwaysKeep", true);
    const { tool } = setup();
    const ctx = createMockCtx();
    const result = await tool.execute("1", { agent: "explore", prompt: "look", name: "auto" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("keep: true");
    const continued = await tool.execute("2", { id: "auto", prompt: "again" }, undefined, undefined, ctx);
    expect(continued.isError).toBeFalsy();

    const forced = await tool.execute("3", { agent: "explore", prompt: "one", keep: false }, undefined, undefined, ctx);
    expect(forced.content[0].text).toContain("keep: false");
    const id = forced.content[0].text.match(/subagent_id: (\S+)/)?.[1];
    const forcedContinued = await tool.execute("4", { id, prompt: "again" }, undefined, undefined, ctx);
    expect(forcedContinued.isError).toBeFalsy();
    expect(forcedContinued.content[0].text).toContain("continued: again");
  });

  it("does not shutdown manager on normal session replacement", async () => {
    const runner = new FakeRunner();
    runner.delay = 50;
    const { pi, tool } = setup(runner);
    const ctx = createMockCtx();
    const promise = tool.execute("1", { agent: "explore", prompt: "slow", background: true }, undefined, undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const run = runner.launched[0];
    await emitEvent(pi, "session_shutdown", { reason: "resume", targetSessionFile: "/tmp/other.json" }, ctx);
    expect(run.status).toBe("running");
    await promise;
  });

  it("shutdowns an injected manager on reload", async () => {
    const runner = new FakeRunner();
    const manager = new SubagentManager({ runner });
    const pi = createMockPi();
    createSubagentsExtension({ manager })(pi as any);
    await emitEvent(pi, "session_shutdown", { reason: "reload" }, createMockCtx());
    expect(manager.list().length).toBe(0);
  });

  it("shutdown does not inject background completion after runner settles", async () => {
    const runner = new FakeRunner();
    runner.delay = 20;
    const { pi, tool } = setup(runner);
    const ctx = createMockCtx();
    const promise = tool.execute("1", { agent: "explore", prompt: "slow", background: true }, undefined, undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await emitEvent(pi, "session_shutdown", { reason: "reload" }, ctx);
    await promise;
    expect(pi.userMessages.some((message) => message.message.includes("Background subagent completed"))).toBe(false);
  });

  it("shutdowns manager on reload", async () => {
    const runner = new FakeRunner();
    runner.delay = 50;
    const { pi, tool } = setup(runner);
    const ctx = createMockCtx();
    const promise = tool.execute("1", { agent: "explore", prompt: "slow", background: true }, undefined, undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const run = runner.launched[0];
    await emitEvent(pi, "session_shutdown", { reason: "reload" }, ctx);
    expect(run.status).toBe("interrupted");
    await promise;
  });

  it("background launch injects completion without asking the model to poll", async () => {
    const { pi, tool } = setup();
    const ctx = createMockCtx();
    await emitEvent(pi, "session_start", {}, ctx);
    const result = await tool.execute("1", { agent: "explore", prompt: "bg", background: true, model: "openai-codex/gpt-5.4-mini" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("state: running");
    expect(result.content[0].text).toContain("follow-up message");
    expect(result.content[0].text).not.toContain("to poll");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pi.userMessages.at(-1)?.message).toContain("Background subagent completed");
    expect(pi.userMessages.at(-1)?.message).toContain("openai-codex/gpt-5.4-mini");
  });

  it("does not let nested factory loading steal background injection", async () => {
    const childPi = createMockPi();
    class NestedFactoryRunner extends FakeRunner {
      async launch(input: any, run: SubagentRun): Promise<SubagentRun> {
        createSubagentsExtension({ runner: new FakeRunner() })(childPi as any);
        return super.launch(input, run);
      }
    }
    const { pi, tool } = setup(new NestedFactoryRunner());
    const ctx = createMockCtx();
    await emitEvent(pi, "session_start", {}, ctx);
    await tool.execute("1", { agent: "explore", prompt: "bg", background: true }, undefined, undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pi.userMessages.at(-1)?.message).toContain("Background subagent completed");
    expect(childPi.userMessages).toEqual([]);
  });

  it("queues background completion during session replacement and flushes after resume", async () => {
    const runner = new FakeRunner();
    runner.delay = 20;
    const { pi, tool } = setup(runner);
    const ctx = createMockCtx();
    await emitEvent(pi, "session_start", {}, ctx);
    await tool.execute("1", { agent: "explore", prompt: "bg", background: true }, undefined, undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await emitEvent(pi, "session_shutdown", { reason: "resume", targetSessionFile: "/tmp/resumed.jsonl" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(pi.userMessages.some((message) => message.message.includes("Background subagent completed"))).toBe(false);
    await emitEvent(pi, "session_start", { reason: "resume" }, ctx);
    expect(pi.userMessages.at(-1)?.message).toContain("Background subagent completed");
  });

  it("does not forward live updates for initially backgrounded runs", async () => {
    const runner = {
      async launch(_input: any, run: SubagentRun) {
        run.events.push({ type: "text_delta", text: "hi", at: Date.now() });
        run.persist?.();
        run.status = "completed";
        run.completedAt = Date.now();
        return run;
      },
    } satisfies Runner;
    const { tool } = setup(runner);
    const ctx = createMockCtx();
    const updates: any[] = [];
    await tool.execute("1", { agent: "explore", prompt: "bg", background: true }, undefined, (update: any) => updates.push(update), ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates).toEqual([]);
  });

  it("shortcut detaches foreground subagents", async () => {
    const runner = new FakeRunner();
    runner.delay = 30;
    const { pi, tool } = setup(runner);
    const ctx = createMockCtx();
    const promise = tool.execute("1", { agent: "explore", prompt: "slow" }, new AbortController().signal, undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await getRegisteredShortcut(pi, "ctrl+shift+b").handler(ctx);
    const result = await promise;
    expect(result.content[0].text).toContain("Moved to background");
  });

  it("background all only detaches current parent foreground runs", async () => {
    const runner = new FakeRunner();
    runner.delay = 200;
    const { pi, tool } = setup(runner);
    const parentAFile = join(mkdtempSync(join(tmpdir(), "pi-parent-a-")), "parent.jsonl");
    const parentBFile = join(mkdtempSync(join(tmpdir(), "pi-parent-b-")), "parent.jsonl");
    writeFileSync(parentAFile, "{}\n");
    writeFileSync(parentBFile, "{}\n");
    const parentA = ctxForSession(parentAFile);
    const parentB = ctxForSession(parentBFile);
    const promiseA = tool.execute("1", { agent: "explore", prompt: "a" }, undefined, undefined, parentA);
    const promiseB = tool.execute("2", { agent: "explore", prompt: "b" }, undefined, undefined, parentB);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runCommand(pi, "subagent", "background", parentA);
    const runA = runner.launched.find((run) => run.prompt === "a");
    const runB = runner.launched.find((run) => run.prompt === "b");
    expect(runA?.parentSessionKey).toBe(parentAFile);
    expect(runB?.parentSessionKey).toBe(parentBFile);
    expect(runA?.background).toBe(true);
    expect(runB?.background).toBe(false);
    runner.launched.forEach((run) => run.detach?.());
    await Promise.all([promiseA, promiseB]);
    rmSync(dirname(parentAFile), { recursive: true, force: true });
    rmSync(dirname(parentBFile), { recursive: true, force: true });
  });

  it("cleans up foreground state when runner launch rejects", async () => {
    const runner: Runner = { launch: async () => { throw new Error("boom"); } };
    const { tool } = setup(runner);
    const ctx = createMockCtx();
    const result = await tool.execute("1", { agent: "explore", prompt: "fail" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("state: error");
    expect(result.content[0].text).toContain("boom");
    const list = await tool.execute("2", {}, undefined, undefined, ctx);
    expect(list.content[0].text).toContain("[error");
  });

  it("kept cancelled subagents reset abort state before continuation", async () => {
    const runner = new FakeRunner();
    runner.delay = 30;
    const { tool } = setup(runner);
    const ctx = createMockCtx();
    const launched = await tool.execute("1", { agent: "explore", prompt: "one", keep: true, name: "keep-cancel", background: true }, undefined, undefined, ctx);
    const id = launched.content[0].text.match(/subagent_id: (\S+)/)?.[1];
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tool.execute("2", { action: "cancel", id }, undefined, undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 35));
    const continued = await tool.execute("3", { id: "keep-cancel", prompt: "again" }, undefined, undefined, ctx);
    expect(continued.content[0].text).toContain("continued: again");
  });

  it("tool details are structured-clone safe", async () => {
    const { tool } = setup();
    const ctx = createMockCtx();
    const result = await tool.execute("1", { agent: "explore", prompt: "clone" }, undefined, undefined, ctx);
    expect(() => structuredClone(result.details)).not.toThrow();
  });

  it("parent abort cancels a foreground subagent that was not backgrounded", async () => {
    const runner = new FakeRunner();
    runner.delay = 30;
    const { tool } = setup(runner);
    const controller = new AbortController();
    const ctx = createMockCtx();
    const promise = tool.execute("1", { agent: "explore", prompt: "slow" }, controller.signal, undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const run = runner.launched[0];
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(run.status).toBe("cancelled");
    const result = await promise;
    expect(result.content[0].text).toContain("state: cancelled");
  });

  it("parent abort before runner wires cancel still marks run cancelled", async () => {
    const runner: Runner = {
      async launch(_input, run) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (run.abortController.signal.aborted) {
          run.status = "cancelled";
          return run;
        }
        run.status = "completed";
        return run;
      },
    };
    const { tool } = setup(runner);
    const controller = new AbortController();
    const ctx = createMockCtx();
    const promise = tool.execute("1", { agent: "explore", prompt: "slow" }, controller.signal, undefined, ctx);
    controller.abort();
    const result = await promise;
    expect(result.content[0].text).toContain("state: cancelled");
  });

  it("already-aborted parent signal prevents launch from completing", async () => {
    const runner: Runner = {
      async launch(_input, run) {
        expect(run.abortController.signal.aborted).toBe(true);
        run.status = "cancelled";
        return run;
      },
    };
    const { tool } = setup(runner);
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute("1", { agent: "explore", prompt: "slow" }, controller.signal, undefined, createMockCtx());
    expect(result.content[0].text).toContain("state: cancelled");
  });

  it("shutdown aborts runs before runner wires cancel", async () => {
    let captured: SubagentRun | undefined;
    const runner: Runner = {
      async launch(_input, run) {
        captured = run;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return run;
      },
    };
    const manager = new SubagentManager({ runner });
    const pi = createMockPi();
    createSubagentsExtension({ manager })(pi as any);
    flushPipTools(pi as any);
    const tool = getRegisteredTool(pi, "subagent");
    const promise = tool.execute("1", { agent: "explore", prompt: "slow", background: true }, undefined, undefined, createMockCtx());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await emitEvent(pi, "session_shutdown", { reason: "reload" }, createMockCtx());
    expect(captured?.abortController.signal.aborted).toBe(true);
    await promise;
  });

  it("/subagent open/back are disabled in favor of view", async () => {
    const { pi } = setup();
    const ctx = createMockCtx();
    await runCommand(pi, "subagent", "open sa_missing", ctx);
    expect(ctx.ui.notifications.at(-1).message).toContain("/subagent view");
    await runCommand(pi, "subagent", "back", ctx);
    expect(ctx.ui.notifications.at(-1).message).toContain("/subagent view");
  });

  it("/subagent view opens a manager-backed custom viewer", async () => {
    const { pi, tool } = setup();
    const ctx = createMockCtx();
    let rendered = "";
    ctx.ui.custom = async (factory: any, options: any) => {
      expect(options.overlayOptions.width).toBe("100%");
      expect(options.overlayOptions.maxHeight).toBe("100%");
      const component = await factory({ requestRender() {} }, {}, {}, () => undefined);
      rendered = component.render(100).join("\n");
      component.dispose?.();
    };
    const result = await tool.execute("1", { agent: "explore", prompt: "view me", model: "openai-codex/gpt-5.4-mini" }, undefined, undefined, ctx);
    const id = result.content[0].text.match(/subagent_id: (\S+)/)?.[1];
    await runCommand(pi, "subagent", `view ${id}`, ctx);
    expect(rendered).toContain(`Subagent ${id}`);
    expect(rendered).toContain("openai-codex/gpt-5.4-mini");
    expect(rendered).toContain("view me");
    expect(rendered).toContain("scroll");
  });

  it("/subagent view steers inline without opening the global input", async () => {
    const runner = new FakeRunner();
    runner.delay = 30;
    const { pi, tool } = setup(runner);
    const ctx = createMockCtx();
    ctx.ui.input = async () => { throw new Error("global input should not open"); };
    let component: any;
    ctx.ui.custom = async (factory: any) => {
      component = await factory({ requestRender() {} }, {}, {}, () => undefined);
    };
    const result = await tool.execute("1", { agent: "explore", prompt: "view me", background: true }, undefined, undefined, ctx);
    const id = result.content[0].text.match(/subagent_id: (\S+)/)?.[1];
    await runCommand(pi, "subagent", `view ${id}`, ctx);

    component.handleInput("s");
    for (const char of "new direction") component.handleInput(char);
    component.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const output = component.render(100).join("\n");
    expect(output).toContain("steer");
    expect(output).toContain("new direction");
    expect(output).not.toContain("mid-run steering note");
    expect(output).not.toContain("original delegated task");
    component.dispose?.();
  });

  it("/subagent steer reports success for completed ephemeral runs", async () => {
    const { pi, tool } = setup();
    const ctx = createMockCtx();
    const result = await tool.execute("1", { agent: "explore", prompt: "look" }, undefined, undefined, ctx);
    expect(result.isError).toBeFalsy();
    const id = result.content[0].text.match(/subagent_id: (\S+)/)?.[1];
    await runCommand(pi, "subagent", `steer ${id} go left`, ctx);
    expect(ctx.ui.notifications.at(-1).message).toContain("Steered");
  });

  it("/subagent view renders stable full-height frames", async () => {
    const { pi, tool } = setup();
    const ctx = createMockCtx();
    const oldRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { configurable: true, value: 20 });
    let heights: number[] = [];
    ctx.ui.custom = async (factory: any) => {
      const component = await factory({ requestRender() {} }, {}, {}, () => undefined);
      heights.push(component.render(100).length);
      component.handleInput("s");
      heights.push(component.render(100).length);
      component.handleInput("escape");
      heights.push(component.render(100).length);
      component.dispose?.();
    };
    try {
      const result = await tool.execute("1", { agent: "explore", prompt: "view me" }, undefined, undefined, ctx);
      const id = result.content[0].text.match(/subagent_id: (\S+)/)?.[1];
      await runCommand(pi, "subagent", `view ${id}`, ctx);
    } finally {
      Object.defineProperty(process.stdout, "rows", { configurable: true, value: oldRows });
    }
    expect(heights).toEqual([20, 20, 20]);
  });
});
