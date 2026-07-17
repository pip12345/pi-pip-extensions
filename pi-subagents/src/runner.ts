import { createHash } from "node:crypto";
import { mkdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { addUsage, emptyUsage, normalizeUsage, pipPath } from "../../pip-common/index.ts";
import type { AgentTools, LaunchInput, Runner, SubagentRun } from "./types.ts";
import { BUILTIN_TOOL_NAMES } from "./agents.ts";
import { parseModelRef } from "./model-ref.ts";
import { snapshotRun } from "./snapshot.ts";
import { PiChildAgentRuntime, type ChildAgentRuntime, type ChildAgentRuntimeSession } from "./child-runtime.ts";
import { boundSubagentResult, boundSubagentText, MAX_SUBAGENT_EVENT_TEXT_CHARS, MAX_SUBAGENT_EVENTS, MAX_SUBAGENT_RESULT_CHARS } from "./bounds.ts";

function safePart(value: string): string {
  const slug = value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "unknown";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

export function privateSessionDir(parentSessionKey: string): string {
  return pipPath("subagents", "sessions", safePart(parentSessionKey));
}

export function deleteRunSessionFile(run: SubagentRun): void {
  if (!run.sessionFile) return;
  rmSync(run.sessionFile, { force: true });
  try { rmdirSync(dirname(run.sessionFile)); } catch {}
}

function summarizeArgs(args: any): string {
  if (!args || typeof args !== "object") return "";
  const keys = ["path", "pattern", "query", "command", "url", "literal"].filter((key) => args[key] != null);
  const parts = keys.slice(0, 2).map((key) => String(args[key]).replace(/\s+/g, " ").slice(0, 80));
  return parts.join(" ");
}

function textFromMessage(msg: any): string {
  const parts: string[] = [];
  let remaining = MAX_SUBAGENT_RESULT_CHARS;
  for (const part of Array.isArray(msg?.content) ? msg.content : []) {
    if (part?.type !== "text" || remaining <= 0) continue;
    const text = String(part.text ?? "").slice(0, remaining);
    if (text) parts.push(text);
    remaining -= text.length + 1;
  }
  return boundSubagentText(parts.join("\n"), MAX_SUBAGENT_RESULT_CHARS);
}

function appendBounded(out: string[], value: unknown, remaining: () => number): void {
  const max = remaining();
  if (max <= 0 || value == null) return;
  const raw = typeof value === "string" ? value : String(value);
  const text = raw.slice(0, max * 2).replace(/\s+/g, " ").trim();
  if (!text) return;
  out.push(text.slice(0, max));
}

function summarizeToolResult(result: any): string | undefined {
  // Intentionally tiny and bounded while extracting: the live viewer is a
  // status/log surface, not a full transcript store. Full read/grep/bash
  // outputs can be massive and make the overlay unusable.
  const limit = 180;
  const parts: string[] = [];
  const remaining = () => Math.max(0, limit - parts.join(" ").length);
  if (!result) return undefined;
  if (typeof result === "string") appendBounded(parts, result, remaining);
  else {
    const content = Array.isArray(result.content) ? result.content : [];
    for (const part of content) {
      if (part?.type === "text") appendBounded(parts, part.text, remaining);
      if (remaining() <= 0) break;
    }
    if (!parts.length) appendBounded(parts, result.message, remaining);
    if (!parts.length) appendBounded(parts, result.error, remaining);
    if (!parts.length && result.isError != null) appendBounded(parts, `isError: ${result.isError}`, remaining);
  }
  const text = parts.join(" ").trim();
  if (!text) return undefined;
  return text.length >= limit ? `${text.slice(0, limit - 1)}…` : text;
}

function pushEvent(run: SubagentRun, event: SubagentRun["events"][number]): number {
  if (event.type === "text_delta" || event.type === "steer") event = { ...event, text: boundSubagentText(event.text, MAX_SUBAGENT_EVENT_TEXT_CHARS, 40) };
  else if (event.type === "tool_start") event = { ...event, id: boundSubagentText(event.id, 200, 1), name: boundSubagentText(event.name, 200, 1), argsSummary: boundSubagentText(event.argsSummary, 500, 4) };
  else event = { ...event, id: boundSubagentText(event.id, 200, 1), resultSummary: event.resultSummary ? boundSubagentText(event.resultSummary, 500, 4) : undefined };
  const previous = run.events.at(-1);
  if (previous?.type === "text_delta" && event.type === "text_delta") {
    previous.text = boundSubagentText(previous.text + event.text, MAX_SUBAGENT_EVENT_TEXT_CHARS, 40);
    previous.at = event.at;
    return run.events.length - 1;
  }
  run.events.push(event);
  if (run.events.length > MAX_SUBAGENT_EVENTS) run.events.splice(0, run.events.length - MAX_SUBAGENT_EVENTS);
  return run.events.indexOf(event);
}

function replaceTextEvent(run: SubagentRun, index: number | undefined, text: string, at: number): number {
  if (index != null && run.events[index]?.type === "text_delta") {
    run.events[index] = { type: "text_delta", text: boundSubagentText(text, MAX_SUBAGENT_EVENT_TEXT_CHARS, 40), at };
    return index;
  }
  return pushEvent(run, { type: "text_delta", text, at });
}

function activeTools(tools: AgentTools): string[] | undefined {
  if (tools === "all") return undefined;
  if (tools === "none") return [];
  if (tools === "builtins") return [...BUILTIN_TOOL_NAMES];
  return tools;
}

function withoutNestedSubagent(names: string[]): string[] {
  return names.filter((name) => name !== "subagent");
}

export class RealRunner implements Runner {
  constructor(private readonly runtime: ChildAgentRuntime = new PiChildAgentRuntime()) {}

  async launch(input: LaunchInput, run: SubagentRun): Promise<SubagentRun> {
    let unsubscribe: (() => void) | undefined;
    let session: ChildAgentRuntimeSession["session"] | undefined;
    let promptStarted = false;
    try {
      const dir = privateSessionDir(input.parentSessionKey);
      mkdirSync(dir, { recursive: true });
      if (input.contextRoot) mkdirSync(join(input.contextRoot, "shared"), { recursive: true });
      if (input.runContextDir) mkdirSync(input.runContextDir, { recursive: true });
      const created = await this.runtime.create(input, dir);
      session = created.session;
      const activeSession = session;
      run.session = activeSession;
      run.sessionFile = activeSession.sessionFile;
      run.persist?.();
      if (run.abortController.signal.aborted) {
        await activeSession.abort();
        throw new Error("Cancelled");
      }

      const starts = new Map<string, number>();
      let lastAssistantText = "";
      let assistantEventIndex: number | undefined;
      unsubscribe = activeSession.subscribe((event: any) => {
        const now = Date.now();
        if (event.type === "message_start" && event.message?.role === "assistant") {
          lastAssistantText = "";
          assistantEventIndex = undefined;
        } else if (event.type === "tool_execution_start") {
          starts.set(event.toolCallId, now);
          pushEvent(run, { type: "tool_start", id: event.toolCallId, name: event.toolName, argsSummary: summarizeArgs(event.args), at: now });
        } else if (event.type === "tool_execution_end") {
          const started = starts.get(event.toolCallId);
          starts.delete(event.toolCallId);
          pushEvent(run, { type: "tool_end", id: event.toolCallId, ok: !event.isError, resultSummary: summarizeToolResult(event.result), durationMs: started ? now - started : undefined, at: now });
        } else if (event.type === "message_update" && event.message?.role === "assistant") {
          const text = textFromMessage(event.message);
          if (text.startsWith(lastAssistantText)) {
            const delta = text.slice(lastAssistantText.length);
            if (delta) assistantEventIndex = pushEvent(run, { type: "text_delta", text: delta, at: now });
          } else if (text) {
            assistantEventIndex = replaceTextEvent(run, assistantEventIndex, text, now);
          }
          lastAssistantText = text;
        } else if (event.type === "message_end" && event.message?.role === "assistant") {
          const text = textFromMessage(event.message);
          lastAssistantText = text;
          if (text) run.resultText = boundSubagentResult(text, run.sessionFile);
          const usage = normalizeUsage(event.message.usage);
          if (usage) {
            run.usage ??= emptyUsage();
            addUsage(run.usage, usage);
          }
        }
        run.updatedAt = now;
        run.persist?.();
        if (run.forwarding !== false) {
          try {
            input.onUpdate?.({ content: [{ type: "text", text: run.resultText ?? "" }], details: { run: snapshotRun(run) } });
          } catch {
            run.forwarding = false;
          }
        }
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
        if (run.abortController.signal.aborted) throw new Error("Cancelled");
        await activeSession.prompt(prompt);
        if (run.abortController.signal.aborted) throw new Error("Cancelled");
      }

      run.steer = async (message: string, displayMessage?: string) => {
        if (activeSession.isStreaming) await activeSession.sendUserMessage(message, { deliverAs: "steer" });
        else {
          const previousPrompt = run.prompt;
          await runPrompt(message);
          run.prompt = displayMessage ?? previousPrompt;
        }
      };
      run.continuePrompt = runPrompt;

      const configured = activeTools(input.agent.tools);
      const current = configured ?? activeSession.getActiveToolNames();
      activeSession.setActiveToolsByName(withoutNestedSubagent(current));

      const modelString = input.model ?? input.agent.model;
      if (modelString) {
        const { provider, id } = parseModelRef(modelString);
        const model = created.modelRegistry.find(provider, id);
        if (!model) throw new Error(`Unknown subagent model: ${modelString}. Use subagent({ action: "models", query: ${JSON.stringify(provider)} }) to list available model IDs.`);
        await activeSession.setModel(model);
      }

      promptStarted = true;
      await runPrompt(input.prompt);
    } catch (error) {
      if (!session || !promptStarted) {
        unsubscribe?.();
        if (session) {
          try { session.dispose(); } catch {}
        }
      }
      throw error;
    }
    return run;
  }
}
