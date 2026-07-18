import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { hasTuiCustom, registerPipTool } from "../pip-common/index.ts";
import { discoverAgents, formatAgent, AGENT_TEMPLATE } from "./src/agents.ts";
import { SubagentManager } from "./src/manager.ts";
import { RealRunner } from "./src/runner.ts";
import { renderSubagentCall, renderSubagentResult, formatRunStatus } from "./src/render.ts";
import { SubagentViewer } from "./src/view.ts";
import { parseModelRef } from "./src/model-ref.ts";
import { SubagentParams, type SubagentParamsType } from "./src/schema.ts";
import { registerSubagentSettings, subagentSettings } from "./src/settings.ts";
import type { AgentConfig, Runner, SubagentRun } from "./src/types.ts";


function parentKey(ctx: any): string {
  return ctx?.sessionManager?.getSessionFile?.() ?? ctx?.sessionManager?.getSessionId?.() ?? "unknown";
}

function parentFile(ctx: any): string | undefined {
  return ctx?.sessionManager?.getSessionFile?.();
}

function parentBranchIds(ctx: any): string[] | undefined {
  const branch = ctx?.sessionManager?.getBranch?.();
  if (Array.isArray(branch)) return branch.map((entry: any) => entry?.id).filter((id: any): id is string => typeof id === "string");
  return undefined;
}

function parentAnchorEntryId(ctx: any): string | undefined {
  return ctx?.sessionManager?.getLeafId?.() ?? ctx?.sessionManager?.getLeafEntry?.()?.id;
}

function currentModelString(ctx: any): string | undefined {
  const provider = ctx?.model?.provider;
  const id = ctx?.model?.id;
  return provider && id ? `${provider}/${id}` : undefined;
}

function modelOverrideRequested(params: SubagentParamsType): boolean {
  return params.model != null;
}

function isLaunchRequest(params: SubagentParamsType): boolean {
  return (params.action === "launch" || !params.action) && Boolean(params.agent && params.prompt && !params.id);
}

function launchModelOverride(params: SubagentParamsType): string | undefined {
  if (params.model == null) return undefined;
  return parseModelRef(params.model).value;
}

function textResult(text: string, details?: any) {
  return { content: [{ type: "text" as const, text }], details };
}

function projectTrusted(ctx: any): boolean {
  return ctx?.isProjectTrusted?.() === true;
}

function findAgent(cwd: string, name: string, trusted: boolean): AgentConfig {
  const discovered = discoverAgents(cwd, { projectTrusted: trusted });
  const agent = discovered.agents.find((item) => item.name === name);
  if (!agent) {
    const diagnostics = discovered.diagnostics.length ? `\n\nDiagnostics:\n${discovered.diagnostics.map((d) => `- ${d.path}: ${d.message}`).join("\n")}` : "";
    throw new Error(`Unknown subagent: ${name}. Available: ${discovered.agents.map((a) => a.name).join(", ") || "none"}.${diagnostics}`);
  }
  return agent;
}

function agentNamesPrompt(cwd: string, trusted: boolean): string {
  const names = discoverAgents(cwd, { projectTrusted: trusted }).agents.map((agent) => agent.name);
  if (!names.length) return "";
  return [`Available subagent agents: ${names.join(", ")}.`, "Use only these subagent agent names; do not invent names."].join("\n");
}

function listAgents(cwd: string, trusted: boolean): string {
  const discovered = discoverAgents(cwd, { projectTrusted: trusted });
  const lines = ["Agents:"];
  for (const agent of discovered.agents) lines.push(`- ${agent.name} [${agent.source}] ${agent.description} (${agent.filePath})`);
  if (!discovered.agents.length) lines.push("(none)");
  lines.push("", trusted
    ? "Create project agents in .pi/agents/<name>.md or user agents in ~/.pi/agent/agents/<name>.md. Legacy .agents/*.md is also scanned."
    : "Project agent files are ignored until the project is trusted. User agents live in ~/.pi/agent/agents/<name>.md.", "", "Template:", AGENT_TEMPLATE.trim());
  if (discovered.diagnostics.length) lines.push("", "Diagnostics:", ...discovered.diagnostics.map((d) => `- ${d.path}: ${d.message}`));
  return lines.join("\n");
}

function modelRef(model: any): string {
  return `${model.provider}/${model.id}`;
}

function modelMatches(model: any, query: string): boolean {
  const text = [modelRef(model), model.provider, model.id, model.name, model.api].filter(Boolean).join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((term) => text.includes(term));
}

async function availableSubagentModels(ctx: any, query?: string): Promise<{ text: string; models: Array<{ id: string; name?: string }> }> {
  const registry = ctx?.modelRegistry ?? ModelRegistry.create(AuthStorage.create());
  await Promise.resolve(registry.refresh?.());
  const all = [...(await Promise.resolve(registry.getAvailable?.() ?? []))].sort((a: any, b: any) => modelRef(a).localeCompare(modelRef(b)));
  const q = query?.trim();
  const models = q ? all.filter((model: any) => modelMatches(model, q)) : all;
  const summaries = models.map((model: any) => ({ id: modelRef(model), name: typeof model.name === "string" ? model.name : undefined }));
  const loadError = registry.getError?.();
  const lines = [q ? `Available subagent models matching "${q}" (${models.length}/${all.length}):` : `Available subagent models (${models.length}):`, "Use these exact ids as launch model overrides, e.g. model:'provider/model-id'."];
  if (!all.length) lines.push("(none; configure auth with /login or ~/.pi/agent/models.json)");
  else if (!models.length) lines.push("(no matches)");
  else for (const model of models) lines.push(`- ${modelRef(model)}${model.name && model.name !== model.id ? ` — ${model.name}` : ""}`);
  if (loadError) lines.push("", `Warning loading models.json: ${loadError}`);
  return { text: lines.join("\n"), models: summaries };
}

function runSummary(run: SubagentRun): string {
  const label = run.model ? `${run.agent} ${run.model}` : run.agent;
  return `${run.id}${run.name ? ` (${run.name})` : ""} [${run.status}${run.keep ? ", kept" : ""}${run.background ? ", bg" : ""}] ${label}: ${run.prompt.slice(0, 80)}`;
}

function listRuns(manager: SubagentManager, key?: string): string {
  const runs = manager.list(key);
  if (!runs.length) return "No retained subagents.";
  return runs.map(runSummary).join("\n");
}

function listDir(path: string): string[] {
  if (!existsSync(path)) return ["(missing)"];
  return readdirSync(path).sort().map((entry) => {
    const full = join(path, entry);
    try { return statSync(full).isDirectory() ? `${entry}/` : entry; }
    catch { return entry; }
  });
}

function contextInfo(manager: SubagentManager, key: string, run?: SubagentRun): string {
  if (run) {
    const dir = run.runContextDir ?? join(manager.contextRootFor(run.parentSessionKey), "runs", run.id);
    return [`Subagent context: ${run.id}`, `Run folder: ${dir}`, "", "Files:", ...listDir(dir).map((line) => `- ${line}`)].join("\n");
  }
  const root = manager.contextRootFor(key);
  const shared = join(root, "shared");
  return [`Subagent context root: ${root}`, `Shared folder: ${shared}`, "", "Shared files:", ...listDir(shared).map((line) => `- ${line}`)].join("\n");
}

async function showSubagentView(ctx: any, manager: SubagentManager, run: SubagentRun): Promise<void> {
  if (hasTuiCustom(ctx)) {
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
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = timeoutMs ? new Promise<"timeout">((resolve) => { timeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs); }) : new Promise<"timeout">(() => undefined);
  try {
    return await Promise.race([runPromise, detached, timeout]);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

export interface SubagentsExtensionOptions {
  runner?: Runner;
  manager?: SubagentManager;
}

export function createSubagentsExtension(options: SubagentsExtensionOptions = {}) {
  return function subagentsExtension(pi: ExtensionAPI) {
    registerSubagentSettings(pi);
    const settings = subagentSettings(pi);
    const runner = options.runner ?? new RealRunner();
    const manager = options.manager ?? new SubagentManager({ runner, settings });
    if (options.manager) manager.configure({ settings });

    const activate = (ctx: any) => {
      manager.configure({ inject: (_key, message) => pi.sendUserMessage(message, { deliverAs: "followUp" }) });
      manager.setActiveParent(parentKey(ctx), parentFile(ctx), parentBranchIds(ctx));
    };

    pi.on("session_start", async (_event: any, ctx: any) => activate(ctx));
    pi.on("session_tree", async (_event: any, ctx: any) => activate(ctx));
    pi.on("before_agent_start", async (event: any, ctx: any) => {
      if (!settings.get("enabled", true)) return;
      const block = agentNamesPrompt(ctx?.cwd ?? process.cwd(), projectTrusted(ctx));
      if (!block) return;
      return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${block}`.trim() };
    });
    pi.on("session_shutdown", async (event: any, ctx: any) => {
      if (event?.reason === "quit" || event?.reason === "reload") {
        await manager.shutdown();
        return;
      }
      if (event?.reason === "resume" || event?.reason === "new" || event?.reason === "fork") manager.deactivateParent(parentKey(ctx));
    });

    pi.registerShortcut?.(Key.ctrlShift("b"), {
      description: "Move foreground subagents to background",
      handler: async (ctx: any) => {
        if (!settings.get("enabled", true)) return ctx.ui?.notify?.("Subagents are disabled in /pip-settings.", "warning");
        activate(ctx);
        const detached = manager.detachAll(parentKey(ctx));
        ctx.ui?.notify?.(detached.length ? `Moved ${detached.length} subagent${detached.length === 1 ? "" : "s"} to background.` : "No foreground subagents running.", "info");
      },
    });

    registerPipTool(pi, {
      tool: {
        name: "subagent",
        label: "subagent",
        description: [
          "Launch and manage quiet subagent task runs with isolated context. The caller must include all context the subagent needs in prompt.",
          "Use action:'agents' to list agent files and creation paths; action:'get_agent' to inspect a default/schema example; action:'models' to list exact available model override ids.",
          "Agent files live in ~/.pi/agent/agents/*.md, .pi/agents/*.md, or legacy .agents/*.md. Launch may pass model:'provider/model-id' to override the agent file model; omitted model override uses the agent model or parent/current model.",
          "Ephemeral subagents can be messaged or steered while retained; each interaction refreshes their TTL. Use keep:true for runs that should not expire.",
          "Use background:true for long tasks. action:'background' moves foreground subagents to background. Nested subagents are disabled. Use /subagent view for live inspection/steering."
        ].join(" "),
        promptSnippet: "Launch and manage quiet subagent task runs with isolated context.",
        promptGuidelines: [
          "Use only listed subagent agent names; call subagent with action:'agents' if unsure.",
          "model is a launch-only override. Use model:'provider/model-id' only when a specific subagent model is desired; omit it to use the agent file model or parent/current model.",
          "Use action:'models' with optional query when you need an exact model override id; do not guess provider/model strings.",
          "Do not repeatedly poll background subagents; Pi sends a follow-up message when background results are ready if background result injection is enabled.",
          "Use subagent status/read for explicit user requests, debugging, or when background result injection is disabled.",
        ],
        parameters: SubagentParams,
        renderCall: renderSubagentCall,
        renderResult: renderSubagentResult,
        async execute(_toolCallId: string, params: SubagentParamsType, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
          if (!settings.get("enabled", true)) throw new Error("Subagents are disabled in /pip-settings.");
          const cwd = ctx?.cwd ?? process.cwd();
          const trusted = projectTrusted(ctx);
          const key = parentKey(ctx);
          activate(ctx);
          try {
            const action = params.action;
            if (modelOverrideRequested(params) && !isLaunchRequest(params)) throw new Error("model overrides are only supported when launching a subagent.");
            if (action === "agents") return textResult(listAgents(cwd, trusted));
            if (action === "models") {
              const available = await availableSubagentModels(ctx, params.query);
              return textResult(available.text, { models: available.models });
            }
            if (action === "get_agent") {
              if (!params.agent) throw new Error("get_agent requires agent.");
              return textResult(formatAgent(findAgent(cwd, params.agent, trusted)));
            }
            if (action === "list" || (!action && !params.agent && !params.id && !params.prompt)) return textResult(listRuns(manager, key));
            if (action === "status" || action === "read") {
              const run = manager.resolve(params.id, key);
              if (!run) throw new Error(`Subagent not found: ${params.id ?? "<missing id>"}`);
              if (params.wait && run.status === "running") await waitRun(run, params.timeoutMs ?? 60_000);
              const snapshot = manager.snapshot(run);
              return textResult(formatRunStatus(snapshot), { run: snapshot });
            }
            if (action === "background") {
              const runs = params.id ? [manager.resolve(params.id, key)].filter((run): run is SubagentRun => Boolean(run)) : manager.detachAll(key);
              if (params.id && !runs.length) throw new Error(`Subagent not found: ${params.id}`);
              for (const run of runs) manager.detach(run);
              return textResult(runs.length ? `Moved ${runs.length} subagent${runs.length === 1 ? "" : "s"} to background.` : "No foreground subagents running.");
            }
            if (action === "cancel") {
              const run = manager.resolve(params.id, key);
              if (!run) throw new Error(`Subagent not found: ${params.id}`);
              await manager.cancel(run);
              const snapshot = manager.snapshot(run);
              return textResult(formatRunStatus(snapshot), { run: snapshot });
            }
            if (action === "keep") {
              const run = manager.resolve(params.id, key);
              if (!run) throw new Error(`Subagent not found: ${params.id}`);
              manager.keep(run);
              return textResult(`Kept subagent ${run.id}.`, { run: manager.snapshot(run) });
            }
            if (action === "forget") {
              const run = manager.resolve(params.id, key);
              if (!run) throw new Error(`Subagent not found: ${params.id}`);
              manager.forget(run);
              return textResult(`Forgot subagent ${run.id}; it is ephemeral now.`);
            }
            if (action === "steer") {
              const run = manager.resolve(params.id, key);
              if (!run) throw new Error(`Subagent not found: ${params.id}`);
              if (!params.message) throw new Error("steer requires message.");
              await manager.steer(run, params.message, findAgent(cwd, run.agent, trusted), signal);
              return textResult(`Steered subagent ${run.id}.`, { run: manager.snapshot(run) });
            }
            if (params.id && params.prompt) {
              const run = manager.resolve(params.id, key);
              if (!run) throw new Error(`Subagent not found: ${params.id}`);
              await manager.continueRun(run, params.prompt, findAgent(cwd, run.agent, trusted), signal);
              const snapshot = manager.snapshot(run);
              return textResult(formatRunStatus(snapshot), { run: snapshot });
            }
            if (!params.agent || !params.prompt) throw new Error("Launch requires agent and prompt, or use an action.");
            const agent = findAgent(cwd, params.agent, trusted);
            const keep = params.keep ?? false;
            const explicitModel = launchModelOverride(params);
            const run = manager.launch({ agent, prompt: params.prompt, cwd, parentSessionKey: key, parentSessionFile: parentFile(ctx), anchorEntryId: parentAnchorEntryId(ctx), name: params.name, keep, background: params.background === true, model: explicitModel ?? (agent.model ? undefined : currentModelString(ctx)), signal, onUpdate });
            const backgroundHint = settings.get("injectBackgroundResults", true)
              ? "Result will arrive as a follow-up message when done; no routine status checks needed."
              : "Background result injection is disabled; use status/read later if needed.";
            if (run.background) return textResult(`subagent_id: ${run.id}\nstate: running\nbackground: true\n\nBackground subagent running. ${backgroundHint}`, { run: manager.snapshot(run) });
            const outcome = await waitRun(run);
            if (outcome === "detached") return textResult(`subagent_id: ${run.id}\nstate: running\nbackground: true\n\nMoved to background. ${backgroundHint}`, { run: manager.snapshot(run) });
            const snapshot = manager.snapshot(run);
            if (run.status === "error") throw new Error(run.errorText ?? `Subagent ${run.id} failed.`);
            if (run.status === "cancelled") throw new Error(`Subagent ${run.id} was cancelled.`);
            return textResult(formatRunStatus(snapshot), { run: snapshot });
          } catch (error) {
            throw error instanceof Error ? error : new Error(String(error));
          }
        },
      },
      metadata: {
        pluginId: "subagents",
        label: "Subagent",
        display: {
          kind: "command",
          call: (args: any) => {
            const label = args?.agent ?? args?.action ?? args?.id ?? "status";
            const model = args?.model ? String(args.model) : undefined;
            const flags = [model ? `model ${model}` : undefined, args?.background ? "background" : undefined, args?.keep ? "keep" : undefined].filter(Boolean).join(" · ");
            return flags ? `${label} ${flags}` : String(label);
          },
          result: (result: any) => result?.details?.run ? undefined : String(result?.content?.find?.((item: any) => item?.type === "text")?.text ?? "").split("\n")[0],
          expandedResult: (result: any) => String(result?.content?.find?.((item: any) => item?.type === "text")?.text ?? ""),
          hideSuccessfulResult: true,
        },
      },
    });

    pi.registerCommand("subagent", {
      description: "Inspect, view, steer, cancel, or background subagents",
      handler: async (args: string, ctx: any) => {
        if (!settings.get("enabled", true)) return ctx.ui?.notify?.("Subagents are disabled in /pip-settings.", "warning");
        activate(ctx);
        const trusted = projectTrusted(ctx);
        const [cmd, ref, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
        try {
          if (!cmd) {
            const entries = manager.list(parentKey(ctx)).map((run) => `${run.id} ${runSummary(run)}`);
            if (!entries.length) return ctx.ui?.notify?.("No retained subagents.", "info");
            const selected = await ctx.ui?.select?.("Subagents", entries);
            if (!selected) return;
            const selectedId = String(selected).split(/\s+/, 1)[0];
            const selectedRun = manager.resolve(selectedId, parentKey(ctx));
            if (!selectedRun) throw new Error(`Subagent not found: ${selectedId}`);
            const actions = ["view", "background", "cancel", selectedRun.keep ? "forget" : "keep", "delete"];
            const action = await ctx.ui?.select?.(`Subagent ${selectedRun.id}`, actions);
            if (!action) return;
            if (action === "view") await showSubagentView(ctx, manager, selectedRun);
            else if (action === "read") ctx.ui?.notify?.(formatRunStatus(manager.snapshot(selectedRun)), "info");
            else if (action === "steer") {
              const message = await ctx.ui?.input?.("Steer subagent", "");
              if (!message) return;
              await manager.steer(selectedRun, message, findAgent(ctx.cwd ?? process.cwd(), selectedRun.agent, trusted), ctx.signal);
              ctx.ui?.notify?.(`Steered ${selectedRun.id}.`, "info");
            } else if (action === "background") { manager.detach(selectedRun); ctx.ui?.notify?.(`Moved ${selectedRun.id} to background.`, "info"); }
            else if (action === "cancel") { await manager.cancel(selectedRun); ctx.ui?.notify?.(`Cancelled ${selectedRun.id}.`, "info"); }
            else if (action === "keep") { manager.keep(selectedRun); ctx.ui?.notify?.(`Kept ${selectedRun.id}.`, "info"); }
            else if (action === "forget") { manager.forget(selectedRun); ctx.ui?.notify?.(`Forgot ${selectedRun.id}; it is ephemeral now.`, "info"); }
            else if (action === "delete") {
              const ok = await ctx.ui?.confirm?.("Delete subagent", `Delete ${selectedRun.id}? This removes its retained run and workspace artifacts.`);
              if (ok) { manager.delete(selectedRun); ctx.ui?.notify?.(`Deleted ${selectedRun.id}.`, "info"); }
            }
            return;
          }
          if (cmd === "agents") {
            if (ref) ctx.ui?.notify?.(formatAgent(findAgent(ctx.cwd ?? process.cwd(), ref, trusted)), "info");
            else ctx.ui?.notify?.(listAgents(ctx.cwd ?? process.cwd(), trusted), "info");
            return;
          }
          if (cmd === "context") {
            if (!ref) return ctx.ui?.notify?.(contextInfo(manager, parentKey(ctx)), "info");
            const run = manager.resolve(ref, parentKey(ctx));
            if (!run) throw new Error(`Subagent not found: ${ref}`);
            return ctx.ui?.notify?.(contextInfo(manager, parentKey(ctx), run), "info");
          }
          if (cmd === "open" || cmd === "back" || cmd === "parent") {
            ctx.ui?.notify?.("Subagent session navigation was removed. Use /subagent view <id> for live output and steering.", "warning");
            return;
          }
          if (cmd === "background") {
            if (ref) {
              const run = manager.resolve(ref, parentKey(ctx));
              if (!run) throw new Error(`Subagent not found: ${ref}`);
              manager.detach(run);
            } else manager.detachAll(parentKey(ctx));
            ctx.ui?.notify?.("Moved foreground subagent(s) to background.", "info");
            return;
          }
          if (!ref && !["list", "context"].includes(cmd)) throw new Error(`/${cmd} requires subagent id or name.`);
          const run = manager.resolve(ref, parentKey(ctx));
          if (cmd === "list") return ctx.ui?.notify?.(listRuns(manager, parentKey(ctx)), "info");
          if (!run) throw new Error(`Subagent not found: ${ref}`);
          if (cmd === "view") await showSubagentView(ctx, manager, run);
          else if (cmd === "steer") {
            const message = rest.join(" ");
            if (!message) throw new Error("steer requires a message.");
            await manager.steer(run, message, findAgent(ctx.cwd ?? process.cwd(), run.agent, trusted), ctx.signal);
            ctx.ui?.notify?.(`Steered ${run.id}.`, "info");
          } else if (cmd === "status" || cmd === "read") ctx.ui?.notify?.(formatRunStatus(manager.snapshot(run)), "info");
          else if (cmd === "keep") { manager.keep(run); ctx.ui?.notify?.(`Kept ${run.id}.`, "info"); }
          else if (cmd === "forget") { manager.forget(run); ctx.ui?.notify?.(`Forgot ${run.id}; it is ephemeral now.`, "info"); }
          else if (cmd === "cancel") { await manager.cancel(run); ctx.ui?.notify?.(`Cancelled ${run.id}.`, "info"); }
          else if (cmd === "delete") {
            const ok = await ctx.ui?.confirm?.("Delete subagent", `Delete ${run.id}? This removes its retained run and workspace artifacts.`);
            if (ok) { manager.delete(run); ctx.ui?.notify?.(`Deleted ${run.id}.`, "info"); }
          }
          else throw new Error(`Unknown /subagent command: ${cmd}`);
        } catch (error) {
          ctx.ui?.notify?.(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
  };
}

export default createSubagentsExtension();
export const __test = { waitRun };
export { discoverAgents } from "./src/agents.ts";
export { SubagentManager } from "./src/manager.ts";
