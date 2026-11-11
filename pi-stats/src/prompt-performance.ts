import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { registerFooterItem } from "../../pip-common/index.ts";

export const PROMPT_PERFORMANCE_ENTRY = "pip-prompt-performance";

export interface PromptPerformance {
  promptEntryId: string;
  durationMs: number;
  generationMs: number;
  outputTokens?: number;
  outcome: "completed" | "aborted" | "error";
}

export function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function promptTokensPerSecond(data?: PromptPerformance): number | undefined {
  if (!data || data.generationMs <= 0 || data.outputTokens === undefined || data.outputTokens <= 0) return undefined;
  return data.outputTokens * 1000 / data.generationMs;
}

export function formatPromptPerformance(data: PromptPerformance): string {
  const parts = [formatDuration(data.durationMs)];
  const speed = promptTokensPerSecond(data);
  if (speed !== undefined) parts.push(`${Math.round(speed)} t/s`);
  if (data.outcome !== "completed") parts.push(data.outcome);
  return parts.join(" · ");
}

export function promptPerformanceById(entries: readonly SessionEntry[]): Map<string, PromptPerformance> {
  const performances = new Map<string, PromptPerformance>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PROMPT_PERFORMANCE_ENTRY) continue;
    const data = entry.data as PromptPerformance | undefined;
    if (data?.promptEntryId) performances.set(data.promptEntryId, data);
  }
  return performances;
}

export function registerPromptPerformance(pi: ExtensionAPI): void {
  let active: { startedAt: number; generationMs: number; outputTokens?: number; outcome: PromptPerformance["outcome"] } | undefined;
  let requestStartedAt: number | undefined;
  let latest: PromptPerformance | undefined;

  registerFooterItem(pi, {
    id: "prompt-performance",
    region: "tokens",
    render: ({ theme }) => latest ? theme.fg("dim", formatPromptPerformance(latest)) : undefined,
  });

  function reset(): void {
    active = undefined;
    requestStartedAt = undefined;
  }

  function restore(_event: unknown, ctx: ExtensionContext): void {
    reset();
    if (ctx.mode !== "tui") return;
    latest = [...promptPerformanceById(ctx.sessionManager.getBranch()).values()].at(-1);
  }

  function finishPrompt(ctx: ExtensionContext, now: number, aborted = false): PromptPerformance | undefined {
    const measured = active;
    active = undefined;
    if (!measured) return;
    const prompt = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message" && entry.message.role === "user");
    if (!prompt) return;
    const data: PromptPerformance = {
      promptEntryId: prompt.id,
      durationMs: Math.max(0, now - measured.startedAt),
      generationMs: measured.generationMs,
      outputTokens: measured.outputTokens,
      outcome: aborted ? "aborted" : measured.outcome,
    };
    pi.appendEntry(PROMPT_PERFORMANCE_ENTRY, data);
    return data;
  }

  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", () => {
    reset();
    latest = undefined;
  });

  pi.on("context", (_event, ctx) => {
    // Request preparation can compact the session before this hook. Keep that
    // overhead in elapsed time, not in the generation speed denominator.
    if (ctx.mode === "tui" && active) requestStartedAt = performance.now();
  });

  pi.on("message_start", (event, ctx) => {
    if (ctx.mode !== "tui" || event.message.role !== "user") return;
    const now = performance.now();
    // User messages are persisted after message_start. A queued prompt closes
    // the previous prompt's timing while its user entry is still the latest one.
    finishPrompt(ctx, now);
    active = { startedAt: now, generationMs: 0, outputTokens: 0, outcome: "completed" };
    requestStartedAt = undefined;
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const startedAt = requestStartedAt;
    requestStartedAt = undefined;
    if (!active || startedAt === undefined) return;
    active.generationMs += Math.max(0, performance.now() - startedAt);
    const output = event.message.usage.output;
    active.outputTokens = active.outputTokens !== undefined && Number.isFinite(output) && output >= 0
      ? active.outputTokens + output
      : undefined;
    active.outcome = event.message.stopReason === "error" ? "error" : event.message.stopReason === "aborted" ? "aborted" : "completed";
  });

  // agent_end can precede retries, compaction, and queued continuations.
  // Only settlement publishes the final metric, after all that work has stopped.
  pi.on("agent_settled", (event: any, ctx) => {
    const data = finishPrompt(ctx, performance.now(), event.aborted);
    requestStartedAt = undefined;
    if (data) latest = data;
  });
}
