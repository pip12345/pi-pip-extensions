import { emptyUsage } from "pip-common";
import type { SubagentRun, SubagentSnapshot } from "./types.ts";

export function snapshotRun(run: SubagentRun): SubagentSnapshot {
  return {
    id: run.id,
    name: run.name,
    agent: run.agent,
    model: run.model,
    prompt: run.prompt,
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
    resultText: run.resultText,
    errorText: run.errorText,
    usage: { ...(run.usage ?? emptyUsage()) },
    events: run.events.slice(-120).map((event) => ({ ...event })),
  };
}
