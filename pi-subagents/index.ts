import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { registerPipTool } from "pip-common";
import { discoverAgents, formatAgent, AGENT_TEMPLATE } from "./src/agents.ts";
import { getManager, resetManagerForTests, shutdownGlobalManager, type SubagentManager } from "./src/manager.ts";
import { RealRunner } from "./src/runner.ts";
import { renderSubagentCall, renderSubagentResult, formatRunStatus } from "./src/render.ts";
import { SubagentViewer } from "./src/view.ts";
import { SubagentParams, type SubagentParamsType } from "./src/schema.ts";
import { registerSubagentSettings, settingValue } from "./src/settings.ts";
import type { AgentConfig, Runner, SubagentRun } from "./src/types.ts";

registerSubagentSettings();

function parentKey(ctx: any): string {
  return ctx?.sessionManager?.getSessionFile?.() ?? ctx?.sessionManager?.getSessionId?.() ?? "unknown";
}

function parentFile(ctx: any): string | undefined {
  return ctx?.sessionManager?.getSessionFile?.();
}

function currentModelString(ctx: any): string | undefined {
  const provider = ctx?.model?.provider;
  const id = ctx?.model?.id;
  return provider && id ? `${provider}/${id}` : undefined;
}

function textResult(text: string, details?: any, isError = false) {
  return { content: [{ type: "text" as const, text }], details, isError };
}

function findAgent(cwd: string, name: string): AgentConfig {
  const discovered = discoverAgents(cwd);
  const agent = discovered.agents.find((item) => item.name === name);
  if (!agent) {
    const diagnostics = discovered.diagnostics.length ? `\n\nDiagnostics:\n${discovered.diagnostics.map((d) => `- ${d.path}: ${d.message}`).join("\n")}` : "";
    throw new Error(`Unknown subagent: ${name}. Available: ${discovered.agents.map((a) => a.name).join(", ") || "none"}.${diagnostics}`);
  }
  return agent;
}

function listAgents(cwd: string): string {
  const discovered = discoverAgents(cwd);
  const lines = ["Agents:"];
  for (const agent of discovered.agents) lines.push(`- ${agent.name} [${agent.source}] ${agent.description} (${agent.filePath})`);
  if (!discovered.agents.length) lines.push("(none)");
  lines.push("", "Create project agents in .pi/agents/<name>.md or user agents in ~/.pi/agent/agents/<name>.md. Legacy .agents/*.md is also scanned.", "", "Template:", AGENT_TEMPLATE.trim());
  if (discovered.diagnostics.length) lines.push("", "Diagnostics:", ...discovered.diagnostics.map((d) => `- ${d.path}: ${d.message}`));
  return lines.join("\n");
}

function runSummary(run: SubagentRun): string {
  return `${run.id}${run.name ? ` (${run.name})` : ""} [${run.status}${run.keep ? ", kept" : ""}${run.background ? ", bg" : ""}] ${run.agent}: ${run.prompt.slice(0, 80)}`;
}

function listRuns(manager: SubagentManager, key?: string): string {
  const runs = manager.list(key);
  if (!runs.length) return "No retained subagents.";
  return runs.map(runSummary).join("\n");
}

async function showSubagentView(ctx: any, manager: SubagentManager, run: SubagentRun): Promise<void> {
  if (ctx.ui?.custom) {
    await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => new SubagentViewer(tui, theme, done, ctx, manager, run.id), {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0, minWidth: 70 },
    });
  } else {
    ctx.ui?.notify?.(formatRunStatus(manager.snapshot(run)), "info");
  }
}

async function waitRun(run: SubagentRun, timeoutMs?: number): Promise<"done" | "timeout" | "detached"> {
  const runPromise = run.runPromise?.then(() => "done" as const) ?? Promise.resolve("done" as const);
  const detached = run.detachPromise?.then(() => "detached" as const) ?? new Promise<"detached">(() => undefined);
  const timeout = timeoutMs ? new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)) : new Promise<"timeout">(() => undefined);
  return Promise.race([runPromise, detached, timeout]);
}

export interface SubagentsExtensionOptions {
  runner?: Runner;
  manager?: SubagentManager;
}

export function createSubagentsExtension(options: SubagentsExtensionOptions = {}) {
  return function subagentsExtension(pi: ExtensionAPI) {
    const runner = options.runner ?? new RealRunner();
    const manager = options.manager ?? getManager({ runner, inject: (_key, message) => pi.sendUserMessage(message, { deliverAs: "followUp" }) });

    const activate = (ctx: any) => manager.setActiveParent(parentKey(ctx));

    pi.on("session_start", async (_event: any, ctx: any) => activate(ctx));
    pi.on("session_tree", async (_event: any, ctx: any) => activate(ctx));
    pi.on("session_shutdown", async (event: any) => {
      if (event?.reason !== "quit" && event?.reason !== "reload") return;
      if (options.manager) await manager.shutdown();
      else await shutdownGlobalManager();
    });

    pi.registerShortcut?.(Key.ctrlShift("b"), {
      description: "Move foreground subagents to background",
      handler: async (ctx: any) => {
        const detached = manager.detachAll();
        ctx.ui?.notify?.(detached.length ? `Moved ${detached.length} subagent${detached.length === 1 ? "" : "s"} to background.` : "No foreground subagents running.", "info");
      },
    });

    registerPipTool(pi, {
      tool: {
        name: "subagent",
        label: "subagent",
        description: [
          "Launch and manage quiet subagent task runs with isolated context. The caller must include all context the subagent needs in prompt.",
          "Use action:'agents' to list agent files and creation paths; action:'get_agent' to inspect a default/schema example.",
          "Agent files live in ~/.pi/agent/agents/*.md, .pi/agents/*.md, or legacy .agents/*.md. Omitted model uses the parent/current model; omitted tools means all tools.",
          "Ephemeral subagents cannot be continued after completion. Use keep:true for reusable runs; /pip-settings can enable Always keep.",
          "Use background:true for long tasks. action:'background' moves foreground subagents to background. Nested subagents are disabled. Use /subagent view for live inspection/steering."
        ].join(" "),
        parameters: SubagentParams,
        renderCall: renderSubagentCall,
        renderResult: renderSubagentResult,
        async execute(_toolCallId: string, params: SubagentParamsType, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
          if (!settingValue("enabled", true)) return textResult("Subagents are disabled in /pip-settings.", undefined, true);
          const cwd = ctx?.cwd ?? process.cwd();
          const key = parentKey(ctx);
          activate(ctx);
          try {
            const action = params.action;
            if (action === "agents") return textResult(listAgents(cwd));
            if (action === "get_agent") {
              if (!params.agent) throw new Error("get_agent requires agent.");
              return textResult(formatAgent(findAgent(cwd, params.agent)));
            }
            if (action === "list" || (!action && !params.agent && !params.id && !params.prompt)) return textResult(listRuns(manager, key));
            if (action === "status" || action === "read") {
              const run = manager.resolve(params.id);
              if (!run) throw new Error(`Subagent not found: ${params.id ?? "<missing id>"}`);
              if (params.wait && run.status === "running") await waitRun(run, params.timeoutMs ?? 60_000);
              const snapshot = manager.snapshot(run);
              return textResult(formatRunStatus(snapshot), { run: snapshot }, run.status === "error");
            }
            if (action === "background") {
              const runs = params.id ? [manager.resolve(params.id)].filter((run): run is SubagentRun => Boolean(run)) : manager.detachAll();
              if (params.id && !runs.length) throw new Error(`Subagent not found: ${params.id}`);
              for (const run of runs) manager.detach(run);
              return textResult(runs.length ? `Moved ${runs.length} subagent${runs.length === 1 ? "" : "s"} to background.` : "No foreground subagents running.");
            }
            if (action === "cancel") {
              const run = manager.resolve(params.id);
              if (!run) throw new Error(`Subagent not found: ${params.id}`);
              await manager.cancel(run);
              const snapshot = manager.snapshot(run);
              return textResult(formatRunStatus(snapshot), { run: snapshot });
            }
            if (action === "keep") {
              const run = manager.resolve(params.id);
              if (!run) throw new Error(`Subagent not found: ${params.id}`);
              manager.keep(run);
              return textResult(`Kept subagent ${run.id}.`, { run: manager.snapshot(run) });
            }
            if (action === "forget") {
              const run = manager.resolve(params.id);
              if (!run) throw new Error(`Subagent not found: ${params.id}`);
              manager.forget(run);
              return textResult(`Forgot subagent ${run.id}.`);
            }
            if (action === "steer") {
              const run = manager.resolve(params.id);
              if (!run) throw new Error(`Subagent not found: ${params.id}`);
              if (!params.message) throw new Error("steer requires message.");
              await manager.steer(run, params.message);
              return textResult(`Steered subagent ${run.id}.`, { run: manager.snapshot(run) });
            }
            if (params.id && params.prompt) {
              const run = manager.resolve(params.id);
              if (!run) throw new Error(`Subagent not found: ${params.id}`);
              await manager.continueRun(run, params.prompt);
              const snapshot = manager.snapshot(run);
              return textResult(formatRunStatus(snapshot), { run: snapshot }, run.status === "error");
            }
            if (!params.agent || !params.prompt) throw new Error("Launch requires agent and prompt, or use an action.");
            const agent = findAgent(cwd, params.agent);
            const keep = params.keep ?? settingValue("alwaysKeep", false);
            const run = manager.launch({ agent, prompt: params.prompt, cwd, parentSessionKey: key, parentSessionFile: parentFile(ctx), name: params.name, keep, background: params.background === true, model: agent.model ? undefined : currentModelString(ctx), signal, onUpdate });
            if (run.background) return textResult(`subagent_id: ${run.id}\nstate: running\nbackground: true\n\nBackground subagent running. Use subagent({action:"status", id:"${run.id}"}) to poll.`, { run: manager.snapshot(run) });
            const outcome = await waitRun(run);
            if (outcome === "detached") return textResult(`subagent_id: ${run.id}\nstate: running\nbackground: true\n\nMoved to background. Use subagent({action:"status", id:"${run.id}"}) to poll.`, { run: manager.snapshot(run) });
            const snapshot = manager.snapshot(run);
            return textResult(formatRunStatus(snapshot), { run: snapshot }, run.status === "error");
          } catch (error) {
            return textResult(error instanceof Error ? error.message : String(error), undefined, true);
          }
        },
      },
      metadata: { pluginId: "subagents", label: "Subagent" },
    });

    pi.registerCommand("subagent", {
      description: "Inspect, view, steer, cancel, or background subagents",
      handler: async (args: string, ctx: any) => {
        activate(ctx);
        const [cmd, ref, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
        try {
          if (!cmd) {
            const entries = manager.list(parentKey(ctx)).map((run) => `${run.id} ${runSummary(run)}`);
            if (!entries.length) return ctx.ui?.notify?.("No retained subagents.", "info");
            const selected = await ctx.ui?.select?.("Subagents", entries);
            if (!selected) return;
            const selectedId = String(selected).split(/\s+/, 1)[0];
            const selectedRun = manager.resolve(selectedId);
            if (!selectedRun) throw new Error(`Subagent not found: ${selectedId}`);
            const actions = ["view", "read", "steer", "background", "cancel", selectedRun.keep ? "forget" : "keep"];
            const action = await ctx.ui?.select?.(`Subagent ${selectedRun.id}`, actions);
            if (!action) return;
            if (action === "view") await showSubagentView(ctx, manager, selectedRun);
            else if (action === "read") ctx.ui?.notify?.(formatRunStatus(manager.snapshot(selectedRun)), "info");
            else if (action === "steer") {
              const message = await ctx.ui?.input?.("Steer subagent", "");
              if (!message) return;
              await manager.steer(selectedRun, message);
              ctx.ui?.notify?.(`Steered ${selectedRun.id}.`, "info");
            } else if (action === "background") { manager.detach(selectedRun); ctx.ui?.notify?.(`Moved ${selectedRun.id} to background.`, "info"); }
            else if (action === "cancel") { await manager.cancel(selectedRun); ctx.ui?.notify?.(`Cancelled ${selectedRun.id}.`, "info"); }
            else if (action === "keep") { manager.keep(selectedRun); ctx.ui?.notify?.(`Kept ${selectedRun.id}.`, "info"); }
            else if (action === "forget") { manager.forget(selectedRun); ctx.ui?.notify?.(`Forgot ${selectedRun.id}.`, "info"); }
            return;
          }
          if (cmd === "agents") {
            if (ref) ctx.ui?.notify?.(formatAgent(findAgent(ctx.cwd ?? process.cwd(), ref)), "info");
            else ctx.ui?.notify?.(listAgents(ctx.cwd ?? process.cwd()), "info");
            return;
          }
          if (cmd === "open" || cmd === "back" || cmd === "parent") {
            ctx.ui?.notify?.("Subagent session navigation was removed. Use /subagent view <id> for live output and steering.", "warning");
            return;
          }
          if (cmd === "background") {
            if (ref) {
              const run = manager.resolve(ref);
              if (!run) throw new Error(`Subagent not found: ${ref}`);
              manager.detach(run);
            } else manager.detachAll();
            ctx.ui?.notify?.("Moved foreground subagent(s) to background.", "info");
            return;
          }
          if (!ref && !["list"].includes(cmd)) throw new Error(`/${cmd} requires subagent id or name.`);
          const run = manager.resolve(ref);
          if (cmd === "list") return ctx.ui?.notify?.(listRuns(manager, parentKey(ctx)), "info");
          if (!run) throw new Error(`Subagent not found: ${ref}`);
          if (cmd === "view") await showSubagentView(ctx, manager, run);
          else if (cmd === "steer") {
            const message = rest.join(" ");
            if (!message) throw new Error("steer requires a message.");
            await manager.steer(run, message);
            ctx.ui?.notify?.(`Steered ${run.id}.`, "info");
          } else if (cmd === "status" || cmd === "read") ctx.ui?.notify?.(formatRunStatus(manager.snapshot(run)), "info");
          else if (cmd === "keep") { manager.keep(run); ctx.ui?.notify?.(`Kept ${run.id}.`, "info"); }
          else if (cmd === "forget") { manager.forget(run); ctx.ui?.notify?.(`Forgot ${run.id}.`, "info"); }
          else if (cmd === "cancel") { await manager.cancel(run); ctx.ui?.notify?.(`Cancelled ${run.id}.`, "info"); }
          else throw new Error(`Unknown /subagent command: ${cmd}`);
        } catch (error) {
          ctx.ui?.notify?.(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
  };
}

export default createSubagentsExtension();
export { resetManagerForTests };
export { discoverAgents } from "./src/agents.ts";
export { SubagentManager } from "./src/manager.ts";
