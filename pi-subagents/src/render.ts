import { Text } from "@earendil-works/pi-tui";
import { firstResultText, formatCompactUsage, themeFg, truncateToWidth, wrapAnsi, type ScopedSettings } from "../../pip-common/index.ts";
import type { SubagentEvent, SubagentSnapshot } from "./types.ts";
import { boundSubagentResult, boundSubagentText, MAX_SUBAGENT_ERROR_CHARS, MAX_SUBAGENT_STATUS_CHARS } from "./bounds.ts";

type SettingsReader = Pick<ScopedSettings, "get">;
const DEFAULT_SETTINGS: SettingsReader = { get: (_key, fallback) => fallback };

function showUsageCost(settings: SettingsReader): boolean {
  return settings.get("showUsageCost", true);
}

function runFromResult(result: any): SubagentSnapshot | undefined {
  return result?.details?.run;
}

function taskSummary(prompt = "", width = 60): string {
  return truncateToWidth(prompt.replace(/\s+/g, " ").trim(), width);
}

function elapsed(run: SubagentSnapshot): string {
  const end = run.completedAt ?? Date.now();
  const ms = Math.max(0, end - run.createdAt);
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function toolEvents(run: SubagentSnapshot): string[] {
  const starts = new Map<string, Extract<SubagentEvent, { type: "tool_start" }>>();
  const rows: string[] = [];
  for (const event of run.events) {
    if (event.type === "tool_start") {
      starts.set(event.id, event);
      rows.push(`→ ${event.name}${event.argsSummary ? ` ${event.argsSummary}` : ""}`);
    } else if (event.type === "tool_end") {
      const start = starts.get(event.id);
      const prefix = event.ok ? "✓" : "✗";
      const dur = event.durationMs == null ? "" : event.durationMs < 1000 ? ` ${event.durationMs}ms` : ` ${(event.durationMs / 1000).toFixed(1)}s`;
      const text = `${prefix} ${start?.name ?? event.id}${start?.argsSummary ? ` ${start.argsSummary}` : ""}${dur}`;
      let idx = -1;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].startsWith(`→ ${start?.name ?? event.id}`)) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) rows[idx] = text;
      else rows.push(text);
    }
  }
  return rows.slice(-12);
}

function currentText(run: SubagentSnapshot): string {
  const deltas = run.events.filter((event): event is Extract<SubagentEvent, { type: "text_delta" }> => event.type === "text_delta").map((event) => event.text).join("");
  return run.resultText ?? deltas;
}

export function compactLine(run: SubagentSnapshot, width: number, theme: any, settings: SettingsReader = DEFAULT_SETTINGS): string {
  const tools = run.events.filter((event) => event.type === "tool_start").length;
  const state = run.status === "running" ? "running" : run.status === "completed" ? "done" : run.status;
  const bg = run.status === "running" && !run.background ? " · Ctrl+Shift+B bg" : "";
  const err = run.status === "error" ? ` · ${run.errorText ?? "error"}` : "";
  const keep = run.keep ? " · kept" : "";
  const usage = formatCompactUsage(run.usage, { includeCost: showUsageCost(settings), inputMode: "raw" });
  const usagePart = usage ? ` · ${usage}` : "";
  return truncateToWidth(themeFg(theme, "dim", `› subagent ${run.agent} ${run.id}: `) + `${taskSummary(run.prompt, 48)} · ${state} · ${elapsed(run)} · ${tools} tools${usagePart}${keep}${bg}${err}`, width);
}

export function renderSubagentCall(args: any, theme: any) {
  const label = `subagent ${args?.agent ?? args?.action ?? args?.id ?? ""}`.trim();
  const model = args?.model ? String(args.model) : undefined;
  const flags = [model ? `model ${model}` : undefined, args?.background ? "background" : undefined, args?.keep ? "keep" : undefined].filter(Boolean).join(" · ");
  const prompt = typeof args?.prompt === "string" ? args.prompt.replace(/\s+/g, " ").trim() : "";
  const text = [themeFg(theme, "toolTitle", label), flags ? themeFg(theme, "dim", ` ${flags}`) : "", prompt ? themeFg(theme, "muted", ` — ${truncateToWidth(prompt, 120)}`) : ""].join("");
  return new Text(text, 0, 0);
}

export function renderSubagentResult(result: any, options: any, theme: any, settings: SettingsReader = DEFAULT_SETTINGS) {
  const run = runFromResult(result);
  if (!run) return new Text(firstResultText(result), 0, 0);
  const statusColor = run.status === "error" ? "error" : run.status === "completed" ? "success" : run.status === "cancelled" ? "warning" : "accent";
  const toolCount = run.events.filter((event) => event.type === "tool_start").length;
  const usage = formatCompactUsage(run.usage, { includeCost: showUsageCost(settings), inputMode: "raw" });
  const summary = [
    themeFg(theme, statusColor, run.status === "completed" ? "done" : run.status),
    run.model || undefined,
    elapsed(run),
    `${toolCount} tool${toolCount === 1 ? "" : "s"}`,
    usage || undefined,
    run.keep ? "kept" : "ephemeral",
    run.background ? "background" : undefined,
    run.status === "running" && !run.background ? "Ctrl+Shift+B bg" : undefined,
  ].filter(Boolean).join(themeFg(theme, "dim", " · "));

  if (!options?.expanded) {
    const error = run.status === "error" && run.errorText ? themeFg(theme, "error", ` — ${truncateToWidth(run.errorText, 100)}`) : "";
    return new Text(`${summary}${error}`, 0, 0);
  }

  const lines: string[] = [];
  lines.push(summary);
  lines.push(themeFg(theme, "muted", "Prompt:"));
  for (const line of wrapAnsi(run.prompt, 100).slice(0, 8)) lines.push(`  ${line}`);
  const tools = toolEvents(run);
  if (tools.length) {
    lines.push("");
    lines.push(themeFg(theme, "muted", "Tools:"));
    for (const row of tools) lines.push(`  ${row}`);
  }
  const text = run.errorText ? `Error: ${run.errorText}` : currentText(run);
  if (text.trim()) {
    lines.push("");
    lines.push(themeFg(theme, "muted", run.status === "running" ? "Current text:" : "Result:"));
    for (const line of text.split("\n").slice(0, 20)) lines.push(`  ${line}`);
  }
  return new Text(lines.join("\n"), 0, 0);
}

export function formatRunStatus(run: SubagentSnapshot, settings: SettingsReader = DEFAULT_SETTINGS): string {
  const usage = formatCompactUsage(run.usage, { includeCost: showUsageCost(settings), inputMode: "raw" });
  const text = run.errorText
    ? `\nError: ${boundSubagentText(run.errorText, MAX_SUBAGENT_ERROR_CHARS, 40)}`
    : run.resultText ? `\n\n<subagent_result>\n${boundSubagentResult(run.resultText, run.sessionFile, MAX_SUBAGENT_STATUS_CHARS - 1000)}\n</subagent_result>` : "";
  return boundSubagentText([`subagent_id: ${run.id}`, run.name ? `name: ${run.name}` : undefined, `state: ${run.status}`, `agent: ${run.agent}`, run.model ? `model: ${run.model}` : undefined, usage ? `usage: ${usage}` : undefined, `background: ${run.background}`, `keep: ${run.keep}`, text].filter(Boolean).join("\n"), MAX_SUBAGENT_STATUS_CHARS, 220);
}
