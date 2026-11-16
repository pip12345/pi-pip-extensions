import { Text } from "@earendil-works/pi-tui";
import { firstResultText, formatCompactUsage, themeFg, truncateToWidth, wrapAnsi } from "../../pip-common/index.ts";
import type { RunSnapshot } from "./runs.ts";

/** Duration of the latest turn, so idle time between continuations is not counted. */
export function elapsed(run: Pick<RunSnapshot, "turnStartedAt" | "completedAt">): string {
  const ms = Math.max(0, (run.completedAt ?? Date.now()) - run.turnStartedAt);
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function oneLine(text: unknown): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function statusColor(status: RunSnapshot["status"]): string {
  return status === "error" ? "error" : status === "completed" ? "success" : status === "cancelled" ? "warning" : "accent";
}

/** Model-facing text for a run. */
export function formatRun(run: RunSnapshot): string {
  const usage = formatCompactUsage(run.usage, { includeCost: true });
  const lines = [
    `subagent_id: ${run.id}`,
    `state: ${run.status}`,
    `agent: ${run.agent}`,
    run.model ? `model: ${run.model}` : undefined,
    `elapsed: ${elapsed(run)}`,
    `tool_calls: ${run.toolCalls}`,
    usage ? `usage: ${usage}` : undefined,
  ].filter(Boolean);
  if (run.errorText) lines.push("", `Error: ${run.errorText}`);
  else if (run.resultText !== undefined) lines.push("", "<subagent_result>", run.resultText || "(no output)", "</subagent_result>");
  return lines.join("\n");
}

function summaryLine(run: RunSnapshot, theme: any): string {
  const usage = formatCompactUsage(run.usage, { includeCost: true });
  return [
    themeFg(theme, statusColor(run.status), run.status === "completed" ? "done" : run.status),
    run.id,
    run.model,
    elapsed(run),
    `${run.toolCalls} tool${run.toolCalls === 1 ? "" : "s"}`,
    usage || undefined,
    run.background ? "background" : undefined,
  ].filter(Boolean).join(themeFg(theme, "dim", " · "));
}

function callLine(theme: any, title: string, flags: Array<string | undefined>, text?: string): Text {
  const flagText = flags.filter(Boolean).join(" · ");
  const body = oneLine(text);
  return new Text([
    themeFg(theme, "toolTitle", title),
    flagText ? themeFg(theme, "dim", ` ${flagText}`) : "",
    body ? themeFg(theme, "muted", ` — ${truncateToWidth(body, 120)}`) : "",
  ].join(""), 0, 0);
}

export function renderLaunchCall(args: any, theme: any) {
  return callLine(theme, `subagent ${args?.agent ?? ""}`.trim(), [args?.model ? `model ${args.model}` : undefined, args?.background ? "background" : undefined], args?.prompt);
}

export function renderMessageCall(args: any, theme: any) {
  return callLine(theme, `subagent_message ${args?.id ?? ""}`.trim(), [], args?.message);
}

export function renderStatusCall(args: any, theme: any) {
  return callLine(theme, `subagent_status ${args?.id ?? ""}`.trim(), []);
}

export function renderRunResult(result: any, options: any, theme: any) {
  const run: RunSnapshot | undefined = result?.details?.run;
  if (!run) return new Text(options?.expanded ? firstResultText(result) : firstResultText(result).split("\n")[0] ?? "", 0, 0);
  const summary = summaryLine(run, theme);
  if (!options?.expanded) {
    const error = run.errorText ? themeFg(theme, "error", ` — ${truncateToWidth(oneLine(run.errorText), 100)}`) : "";
    return new Text(`${summary}${error}`, 0, 0);
  }
  const lines = [summary, themeFg(theme, "muted", "Task:"), ...wrapAnsi(run.task, 100).slice(0, 8).map((line) => `  ${line}`)];
  const text = run.errorText ? `Error: ${run.errorText}` : run.resultText;
  if (text?.trim()) lines.push("", themeFg(theme, "muted", "Result:"), ...text.split("\n").slice(0, 20).map((line) => `  ${line}`));
  return new Text(lines.join("\n"), 0, 0);
}
