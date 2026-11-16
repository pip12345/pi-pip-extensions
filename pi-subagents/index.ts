import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addUsage, emptyUsage, hasTuiCustom, setPromptInstructions } from "../pip-common/index.ts";
import { discoverAgents, type AgentConfig } from "./src/agents.ts";
import { createChildSession, type CreateChildSession } from "./src/child.ts";
import { parseModelRef } from "./src/model-ref.ts";
import { elapsed, formatRun, renderLaunchCall, renderMessageCall, renderRunResult, renderStatusCall } from "./src/render.ts";
import { snapshot, SubagentRuns, type SubagentRun } from "./src/runs.ts";
import { LaunchParams, MessageParams, StatusParams, type LaunchParamsType, type MessageParamsType, type StatusParamsType } from "./src/schema.ts";
import { registerSubagentSettings, subagentSettings } from "./src/settings.ts";
import { addToPiUsage, hasUsage } from "./src/usage.ts";
import { SubagentViewer } from "./src/view.ts";

function projectTrusted(ctx: any): boolean {
  return ctx?.isProjectTrusted?.() === true;
}

function currentModel(ctx: any): string | undefined {
  const provider = ctx?.model?.provider;
  const id = ctx?.model?.id;
  return provider && id ? `${provider}/${id}` : undefined;
}

function findAgent(cwd: string, name: string, trusted: boolean): AgentConfig {
  const discovered = discoverAgents(cwd, { projectTrusted: trusted });
  const agent = discovered.agents.find((item) => item.name === name);
  if (agent) return agent;
  const diagnostics = discovered.diagnostics.length ? `\n\nDiagnostics:\n${discovered.diagnostics.map((d) => `- ${d.path}: ${d.message}`).join("\n")}` : "";
  throw new Error(`Unknown subagent agent: ${name}. Available: ${discovered.agents.map((a) => a.name).join(", ") || "none"}.${diagnostics}`);
}

function agentsPrompt(cwd: string, trusted: boolean): string {
  const agents = discoverAgents(cwd, { projectTrusted: trusted }).agents;
  if (!agents.length) return "";
  return ["Available subagent agents (use only these names):", ...agents.map((agent) => `- ${agent.name}: ${agent.description}`)].join("\n");
}

function runResult(run: SubagentRun) {
  const details = { run: snapshot(run) };
  return { content: [{ type: "text" as const, text: formatRun(details.run) }], details };
}

/**
 * Result of a foreground turn. It carries the turn's usage, so Pi counts it in session totals. A
 * failed or cancelled turn is an error result rather than a throw, so its usage is still counted.
 */
function finishedResult(run: SubagentRun) {
  const result = runResult(run);
  const usage = hasUsage(run.turnUsage) ? addToPiUsage(undefined, run.turnUsage) : undefined;
  if (run.status === "completed") return { ...result, usage };
  const text = run.status === "cancelled" ? `Subagent ${run.id} was cancelled.` : `Subagent ${run.id} failed: ${run.errorText ?? "unknown error"}`;
  return { ...result, content: [{ type: "text" as const, text }], isError: true, usage };
}

export interface SubagentsExtensionOptions {
  createChild?: CreateChildSession;
}

export function createSubagentsExtension(options: SubagentsExtensionOptions = {}) {
  return function subagentsExtension(pi: ExtensionAPI) {
    registerSubagentSettings(pi);
    const settings = subagentSettings(pi);

    const backgroundNote = () => settings.get("injectBackgroundResults", true)
      ? "The result arrives as a follow-up message when it finishes; do not poll subagent_status."
      : "Background result messages are disabled; use subagent_status later.";

    // Background turns have no tool result of their own to carry their usage, so it is added to the
    // parent's next tool result instead. Usage still pending when the session ends is not counted.
    let unreportedUsage = emptyUsage();
    pi.on("tool_result", (event: any) => {
      if (!hasUsage(unreportedUsage)) return;
      const usage = addToPiUsage(event.usage, unreportedUsage);
      unreportedUsage = emptyUsage();
      return { usage };
    });

    const newRuns = () => new SubagentRuns({
      createChild: options.createChild ?? createChildSession,
      maxRunning: () => settings.get("maxRunning", 6),
      onBackgroundDone: (run) => {
        addUsage(unreportedUsage, run.turnUsage);
        if (run.status === "cancelled" || !settings.get("injectBackgroundResults", true)) return;
        pi.sendUserMessage(`Background subagent ${run.id} finished.\n\n${formatRun(snapshot(run))}`, { deliverAs: "followUp" });
      },
    });
    let runs = newRuns();

    const assertEnabled = () => {
      if (!settings.get("enabled", true)) throw new Error("Subagents are disabled in /pip-settings.");
    };

    pi.on("before_agent_start", async (event: any, ctx: any) => {
      if (!settings.get("enabled", true)) return;
      const block = agentsPrompt(ctx?.cwd ?? process.cwd(), projectTrusted(ctx));
      if (block) setPromptInstructions(event.systemPromptOptions, "pip_subagents", block);
    });

    // Runs belong to one parent session. Replacing or quitting the session stops them.
    pi.on("session_shutdown", async () => {
      unreportedUsage = emptyUsage();
      const closing = runs;
      runs = newRuns();
      await closing.close();
    });

    pi.registerTool({
      name: "subagent",
      label: "subagent",
      description: "Launch a subagent: a separate agent with its own isolated context that runs one task and returns its final answer. The prompt must include all context the subagent needs. Returns a subagent_id that subagent_message and subagent_status accept.",
      promptSnippet: "Launch a subagent with isolated context for a self-contained task.",
      promptGuidelines: [
        "Use only the listed subagent agent names.",
        "Omit model unless a specific model is required. An unknown model fails with the list of valid ids for that provider.",
        "Use background:true for long tasks. Background results arrive as follow-up messages; do not poll subagent_status for them.",
      ],
      parameters: LaunchParams,
      renderCall: renderLaunchCall,
      renderResult: renderRunResult,
      async execute(_toolCallId: string, params: LaunchParamsType, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
        assertEnabled();
        const cwd = ctx?.cwd ?? process.cwd();
        const trusted = projectTrusted(ctx);
        const agent = findAgent(cwd, params.agent, trusted);
        const model = params.model ? parseModelRef(params.model).value : agent.model ? undefined : currentModel(ctx);
        const background = params.background === true;
        const run = runs.launch({
          agent, prompt: params.prompt, cwd, projectTrusted: trusted, model, background,
          signal: background ? undefined : signal,
          onUpdate: background ? undefined : (current) => onUpdate?.(runResult(current)),
        });
        if (background) return { content: [{ type: "text" as const, text: `subagent_id: ${run.id}\nstate: running\nbackground: true\n\n${backgroundNote()}` }], details: { run: snapshot(run) } };
        await run.done;
        return finishedResult(run);
      },
    });

    pi.registerTool({
      name: "subagent_message",
      label: "subagent_message",
      description: "Send a message to a subagent from this session. A running subagent receives it as a steering note and keeps working. A finished subagent continues its conversation with it as the next prompt and returns the new answer.",
      promptSnippet: "Steer a running subagent or continue a finished one.",
      parameters: MessageParams,
      renderCall: renderMessageCall,
      renderResult: renderRunResult,
      async execute(_toolCallId: string, params: MessageParamsType, signal: AbortSignal | undefined, onUpdate: any) {
        assertEnabled();
        const run = runs.get(params.id);
        const background = params.background === true;
        const outcome = await runs.message(run, params.message, {
          background,
          signal: background ? undefined : signal,
          onUpdate: background ? undefined : (current) => onUpdate?.(runResult(current)),
        });
        if (outcome === "steered") return { content: [{ type: "text" as const, text: `Steering note sent to running subagent ${run.id}.` }], details: { run: snapshot(run) } };
        if (background) return { content: [{ type: "text" as const, text: `subagent_id: ${run.id}\nstate: running\nbackground: true\n\n${backgroundNote()}` }], details: { run: snapshot(run) } };
        return finishedResult(run);
      },
    });

    pi.registerTool({
      name: "subagent_status",
      label: "subagent_status",
      description: "Show one subagent's state and latest result, or list this session's subagents when id is omitted.",
      promptSnippet: "Inspect subagents launched in this session.",
      parameters: StatusParams,
      renderCall: renderStatusCall,
      renderResult: renderRunResult,
      async execute(_toolCallId: string, params: StatusParamsType) {
        assertEnabled();
        if (params.id) return runResult(runs.get(params.id));
        const list = runs.list();
        const text = list.length
          ? list.map((run) => `${run.id} [${run.status}] ${run.agent.name}${run.model ? ` ${run.model}` : ""}: ${run.task.replace(/\s+/g, " ").slice(0, 80)}`).join("\n")
          : "No subagents in this session.";
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    });

    const showRun = async (ctx: any, run: SubagentRun) => {
      if (!hasTuiCustom(ctx)) return ctx.ui?.notify?.(formatRun(snapshot(run)), "info");
      await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => new SubagentViewer(tui, theme, done, runs, run), {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0, minWidth: 70 },
      });
    };

    pi.registerCommand("subagent", {
      description: "View a subagent's live transcript, steer it, or cancel it",
      handler: async (args: string, ctx: any) => {
        try {
          assertEnabled();
          const [cmd, id] = (args ?? "").trim().split(/\s+/).filter(Boolean);
          if (cmd === "view" && id) return await showRun(ctx, runs.get(id));
          if (cmd) throw new Error("Usage: /subagent or /subagent view <id>");
          const list = runs.list();
          if (!list.length) return ctx.ui?.notify?.("No subagents in this session.", "info");
          const choices = list.map((run) => [run.id, run.agent.name, run.status, elapsed(run), run.task.replace(/\s+/g, " ").slice(0, 60)].join(" · "));
          const selected = await ctx.ui?.select?.("Subagents", choices);
          if (selected) await showRun(ctx, runs.get(String(selected).split(" · ", 1)[0]));
        } catch (error) {
          ctx.ui?.notify?.(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
  };
}

export default createSubagentsExtension();
