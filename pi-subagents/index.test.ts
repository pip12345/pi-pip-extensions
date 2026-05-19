import { describe, expect, it, beforeEach } from "vitest";
import { createMockCtx, createMockPi, emitEvent, getRegisteredShortcut, getRegisteredTool, runCommand } from "pip-common/testing";
import { flushPipTools, pipSettings, resetPipToolsForTests } from "pip-common";
import { createSubagentsExtension, resetManagerForTests } from "./index.ts";
import { SubagentManager } from "./src/manager.ts";
import type { Runner, SubagentRun } from "./src/types.ts";

class FakeRunner implements Runner {
  delay = 0;
  failContinue = false;
  launched: SubagentRun[] = [];
  async launch(input: any, run: SubagentRun): Promise<SubagentRun> {
    this.launched.push(run);
    run.sessionFile = `/tmp/${run.id}.json`;
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

function setup(runner: Runner = new FakeRunner()) {
  const pi = createMockPi();
  createSubagentsExtension({ runner })(pi as any);
  flushPipTools(pi as any);
  return { pi, runner, tool: getRegisteredTool(pi, "subagent") };
}

beforeEach(() => {
  resetPipToolsForTests();
  resetManagerForTests();
  pipSettings.set("subagents.alwaysKeep", false);
});

describe("pi-subagents", () => {
  it("registers tool, command, and shortcut", () => {
    const { pi, tool } = setup();
    expect(tool).toBeTruthy();
    expect(pi.commands.has("subagent")).toBe(true);
    expect(getRegisteredShortcut(pi, "ctrl+shift+b")).toBeTruthy();
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

  it("runs foreground subagents and prevents ephemeral continuation", async () => {
    const { tool } = setup();
    const ctx = createMockCtx();
    const result = await tool.execute("1", { agent: "explore", prompt: "look around" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("state: completed");
    const id = result.content[0].text.match(/subagent_id: (\S+)/)?.[1];
    const continued = await tool.execute("2", { id, prompt: "again" }, undefined, undefined, ctx);
    expect(continued.isError).toBe(true);
    expect(continued.content[0].text).toContain("ephemeral");
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

  it("alwaysKeep makes new subagents reusable unless keep false", async () => {
    pipSettings.set("subagents.alwaysKeep", true);
    const { tool } = setup();
    const ctx = createMockCtx();
    const result = await tool.execute("1", { agent: "explore", prompt: "look", name: "auto" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("keep: true");
    const continued = await tool.execute("2", { id: "auto", prompt: "again" }, undefined, undefined, ctx);
    expect(continued.isError).toBeFalsy();

    const forced = await tool.execute("3", { agent: "explore", prompt: "one", keep: false }, undefined, undefined, ctx);
    const id = forced.content[0].text.match(/subagent_id: (\S+)/)?.[1];
    const rejected = await tool.execute("4", { id, prompt: "again" }, undefined, undefined, ctx);
    expect(rejected.isError).toBe(true);
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
    expect(run.status).toBe("cancelled");
    await promise;
  });

  it("background launch injects completion", async () => {
    const { pi, tool } = setup();
    const ctx = createMockCtx();
    await emitEvent(pi, "session_start", {}, ctx);
    const result = await tool.execute("1", { agent: "explore", prompt: "bg", background: true }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("state: running");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pi.userMessages.at(-1)?.message).toContain("Background subagent completed");
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
    const result = await tool.execute("1", { agent: "explore", prompt: "view me" }, undefined, undefined, ctx);
    const id = result.content[0].text.match(/subagent_id: (\S+)/)?.[1];
    await runCommand(pi, "subagent", `view ${id}`, ctx);
    expect(rendered).toContain(`Subagent ${id}`);
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

  it("/subagent steer reports success", async () => {
    const { pi, tool } = setup();
    const ctx = createMockCtx();
    const result = await tool.execute("1", { agent: "explore", prompt: "look", keep: true, name: "steerable" }, undefined, undefined, ctx);
    expect(result.isError).toBeFalsy();
    await runCommand(pi, "subagent", "steer steerable go left", ctx);
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
