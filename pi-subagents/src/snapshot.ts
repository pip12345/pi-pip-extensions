import { emptyUsage } from "../../pip-common/index.ts";
import type { SubagentRun, SubagentSnapshot } from "./types.ts";
import { boundSubagentResult, boundSubagentText, MAX_SUBAGENT_ERROR_CHARS, MAX_SUBAGENT_EVENTS, MAX_SUBAGENT_EVENT_TEXT_CHARS, MAX_SUBAGENT_PERSISTED_PROMPT_CHARS } from "./bounds.ts";

export function snapshotRun(run: SubagentRun): SubagentSnapshot {
  const sourceEvents = run.resultText ? run.events.filter((event) => event.type !== "text_delta") : run.events;
  const events = sourceEvents.slice(-MAX_SUBAGENT_EVENTS).map((event) => {
    if (event.type === "steer" || event.type === "text_delta") return { ...event, text: boundSubagentText(event.text, MAX_SUBAGENT_EVENT_TEXT_CHARS, 40) };
    if (event.type === "tool_start") return { ...event, argsSummary: boundSubagentText(event.argsSummary, 500, 4) };
    return { ...event, resultSummary: event.resultSummary ? boundSubagentText(event.resultSummary, 500, 4) : undefined };
  });
  return {
    id: run.id,
    name: run.name,
    agent: run.agent,
    model: run.model,
    prompt: boundSubagentText(run.prompt, MAX_SUBAGENT_PERSISTED_PROMPT_CHARS, 100),
    cwd: run.cwd,
    parentSessionKey: run.parentSessionKey,
    parentSessionFile: run.parentSessionFile,
    keep: run.keep,
    anchorEntryId: run.anchorEntryId,
    background: run.background,
    detached: run.detached,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    sessionFile: run.sessionFile,
    contextRoot: run.contextRoot,
    runContextDir: run.runContextDir,
    resultText: run.resultText ? boundSubagentResult(run.resultText, run.sessionFile) : undefined,
    errorText: run.errorText ? boundSubagentText(run.errorText, MAX_SUBAGENT_ERROR_CHARS, 40) : undefined,
    usage: { ...(run.usage ?? emptyUsage()) },
    events,
  };
}
