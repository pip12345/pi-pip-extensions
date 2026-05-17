import { mkdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createAgentSession, SessionManager, AuthStorage, ModelRegistry, DefaultResourceLoader, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isPipReadOnlyActive, pipPath } from "pip-common";
import type { AgentTools, LaunchInput, Runner, SubagentRun } from "./types.ts";
import { BUILTIN_TOOL_NAMES } from "./agents.ts";
import { snapshotRun } from "./snapshot.ts";

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "unknown";
}

export function privateSessionDir(parentSessionKey: string): string {
  return pipPath("subagents", "sessions", safePart(parentSessionKey));
}

export function deleteRunSessionFile(run: SubagentRun): void {
  if (!run.sessionFile) return;
  rmSync(run.sessionFile, { force: true });
  try { rmdirSync(dirname(run.sessionFile)); } catch {}
}

function summarizeArgs(tool: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  const keys = ["path", "pattern", "query", "command", "url", "literal"].filter((key) => args[key] != null);
  const parts = keys.slice(0, 2).map((key) => String(args[key]).replace(/\s+/g, " ").slice(0, 80));
  return parts.join(" ");
}

function textFromMessage(msg: any): string {
  return (msg?.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("\n");
}

function textFromToolResult(result: any): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("\n");
  if (text) return text;
  if (typeof result.message === "string") return result.message;
  if (typeof result.error === "string") return result.error;
  try { return JSON.stringify(result); } catch { return String(result); }
}

function summarizeToolResult(result: any): string | undefined {
  // Intentionally tiny: the live viewer is a status/log surface, not a full
  // transcript store. Full read/grep/bash outputs can be massive and make the
  // overlay unusable.
  const limit = 180;
  const text = textFromToolResult(result).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function pushEvent(run: SubagentRun, event: SubagentRun["events"][number]): void {
  const previous = run.events.at(-1);
  if (previous?.type === "text_delta" && event.type === "text_delta") {
    previous.text += event.text;
    previous.at = event.at;
  } else {
    run.events.push(event);
  }
  if (run.events.length > 300) run.events.splice(0, run.events.length - 300);
}

function activeTools(tools: AgentTools): string[] | undefined {
  if (tools === "all") return undefined;
  if (tools === "none") return [];
  if (tools === "builtins") return [...BUILTIN_TOOL_NAMES];
  return tools;
}

const MUTATING_TOOLS = new Set(["edit", "write", "todo_write", "todo_update"]);

function finalizeTools(names: string[]): string[] {
  return names.filter((name) => name !== "subagent" && (!isPipReadOnlyActive() || !MUTATING_TOOLS.has(name)));
}

let authStorage: ReturnType<typeof AuthStorage.create> | undefined;
let modelRegistry: ReturnType<typeof ModelRegistry.create> | undefined;

function auth() {
  authStorage ??= AuthStorage.create();
  modelRegistry ??= ModelRegistry.create(authStorage);
  return { authStorage, modelRegistry };
}

export class RealRunner implements Runner {
  async launch(input: LaunchInput, run: SubagentRun): Promise<SubagentRun> {
    let unsubscribe: (() => void) | undefined;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let promptStarted = false;
    try {
      const dir = privateSessionDir(input.parentSessionKey);
      mkdirSync(dir, { recursive: true });
      const { authStorage, modelRegistry } = auth();
      const sessionManager = SessionManager.create(input.cwd, dir);
      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(input.cwd, agentDir);
      const resourceLoader = new DefaultResourceLoader({
        cwd: input.cwd,
        agentDir,
        settingsManager,
        appendSystemPrompt: input.agent.systemPrompt ? [input.agent.systemPrompt] : [],
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter((extension) => {
            const path = `${extension.path} ${extension.resolvedPath}`;
            return !path.includes("pi-subagents") && !path.includes("pi-plan-mode");
          }),
        }),
      });
      await resourceLoader.reload();
      const created = await createAgentSession({ cwd: input.cwd, sessionManager, authStorage, modelRegistry, settingsManager, resourceLoader });
      session = created.session;
      const activeSession = session;
      run.session = activeSession;
      run.sessionFile = activeSession.sessionFile;

      const starts = new Map<string, number>();
      let lastAssistantText = "";
      unsubscribe = activeSession.subscribe((event: any) => {
        const now = Date.now();
        if (event.type === "message_start" && event.message?.role === "assistant") {
          lastAssistantText = "";
        } else if (event.type === "tool_execution_start") {
          starts.set(event.toolCallId, now);
          pushEvent(run, { type: "tool_start", id: event.toolCallId, name: event.toolName, argsSummary: summarizeArgs(event.toolName, event.args), at: now });
        } else if (event.type === "tool_execution_end") {
          const started = starts.get(event.toolCallId);
          starts.delete(event.toolCallId);
          pushEvent(run, { type: "tool_end", id: event.toolCallId, ok: !event.isError, resultSummary: summarizeToolResult(event.result), durationMs: started ? now - started : undefined, at: now });
        } else if (event.type === "message_update" && event.message?.role === "assistant") {
          const text = textFromMessage(event.message);
          const delta = text.startsWith(lastAssistantText) ? text.slice(lastAssistantText.length) : text;
          lastAssistantText = text;
          if (delta) pushEvent(run, { type: "text_delta", text: delta, at: now });
        } else if (event.type === "message_end" && event.message?.role === "assistant") {
          const text = textFromMessage(event.message);
          lastAssistantText = text;
          if (text) run.resultText = text;
        }
        run.updatedAt = now;
        if (run.forwarding !== false) input.onUpdate?.({ content: [{ type: "text", text: run.resultText ?? "" }], details: { run: snapshotRun(run) } });
      });

      run.dispose = () => {
        unsubscribe?.();
        unsubscribe = undefined;
        activeSession.dispose();
      };
      run.cancel = async () => {
        run.abortController.abort();
        await activeSession.abort();
      };

      async function runPrompt(prompt: string): Promise<void> {
        run.status = "running";
        run.prompt = prompt;
        run.errorText = undefined;
        run.resultText = undefined;
        run.completedAt = undefined;
        run.updatedAt = Date.now();
        try {
          await activeSession.prompt(prompt);
          run.status = run.abortController.signal.aborted ? "cancelled" : "completed";
        } catch (error) {
          run.status = run.abortController.signal.aborted ? "cancelled" : "error";
          run.errorText = run.status === "cancelled" ? "Cancelled" : error instanceof Error ? error.message : String(error);
        } finally {
          run.completedAt = Date.now();
          run.updatedAt = run.completedAt;
        }
      }

      run.steer = async (message: string) => {
        if (activeSession.isStreaming) await activeSession.sendUserMessage(message, { deliverAs: "steer" });
        else await runPrompt(message);
      };
      run.continuePrompt = runPrompt;

      const configured = activeTools(input.agent.tools);
      const current = configured ?? activeSession.getActiveToolNames();
      activeSession.setActiveToolsByName(finalizeTools(current));

      const modelString = input.model ?? input.agent.model;
      if (modelString) {
        const [provider, ...rest] = modelString.split("/");
        const id = rest.join("/");
        const model = provider && id ? modelRegistry.find(provider, id) : undefined;
        if (!model) throw new Error(`Unknown subagent model: ${modelString}`);
        await activeSession.setModel(model);
      }

      promptStarted = true;
      await runPrompt(input.prompt);
    } catch (error) {
      run.status = run.abortController.signal.aborted ? "cancelled" : "error";
      run.errorText = run.status === "cancelled" ? "Cancelled" : error instanceof Error ? error.message : String(error);
      run.completedAt = Date.now();
      run.updatedAt = run.completedAt;
      unsubscribe?.();
      if (session && !promptStarted) {
        try { session.dispose(); } catch {}
      }
    }
    return run;
  }
}
