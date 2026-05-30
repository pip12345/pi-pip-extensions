import type { SubagentRun, SubagentSnapshot } from "./types.ts";

export function snapshotRun(run: SubagentRun): SubagentSnapshot {
  return {
    id: run.id,
    name: run.name,
    agent: run.agent,
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
    events: run.events.slice(-120).map((event) => ({ ...event })),
  };
}
