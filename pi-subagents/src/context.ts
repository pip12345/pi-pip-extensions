import { createHash } from "node:crypto";
import { join } from "node:path";
import { pipPath } from "../../pip-common/index.ts";

function safePart(value: string): string {
  const slug = value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "unknown";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

export function contextRoot(parentSessionKey: string, baseDir = pipPath("subagents", "context")): string {
  return join(baseDir, safePart(parentSessionKey));
}

export function sharedContextDir(parentSessionKey: string, baseDir?: string): string {
  return join(contextRoot(parentSessionKey, baseDir), "shared");
}

export function isSafeRunId(runId: unknown): runId is string {
  return typeof runId === "string" && runId.length > 0 && runId.length <= 128 && runId !== "." && runId !== ".." && /^[A-Za-z0-9._-]+$/.test(runId);
}

export function runContextDir(parentSessionKey: string, runId: string, baseDir?: string): string {
  if (!isSafeRunId(runId)) throw new Error(`Invalid subagent run id: ${runId}`);
  return join(contextRoot(parentSessionKey, baseDir), "runs", runId);
}

export function appendWorkspaceGuidance(prompt: string, root?: string, runDir?: string): string {
  if (!root || !runDir) return prompt;
  return [
    prompt.trimEnd(),
    "",
    "<subagent_handoff_workspace>",
    `Shared context folder: ${join(root, "shared")}`,
    `Your run folder: ${runDir}`,
    "",
    "Use chat for the direct answer, key reasoning, next action/fix, and caveats.",
    "Create artifact files when they preserve useful details without bloating the final response: relevant logs, long outputs, evidence, rejected alternatives, repro notes, or data another agent may consume.",
    "Do not archive routine tool output or duplicate what your final answer already says. Organize artifacts clearly and mention relevant paths in final.",
    "</subagent_handoff_workspace>",
  ].join("\n");
}
