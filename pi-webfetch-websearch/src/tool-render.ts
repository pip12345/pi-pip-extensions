import { themeFg, truncateToWidth, wrapAnsi, type ThemeLike } from "../../pip-common/index.ts";

export type ToolOutcome = "success" | "warning" | "error";

export function toolHint(content: string) {
  return {
    render(width: number): string[] {
      return content ? [truncateToWidth(content, Math.max(1, width))] : [];
    },
    invalidate() {},
  };
}

export function renderToolCall(theme: ThemeLike | undefined, tool: string, parts: Array<string | undefined | false>) {
  const detail = parts.filter(Boolean).join(" · ");
  return toolHint(themeFg(theme, "toolTitle", tool) + (detail ? themeFg(theme, "muted", ` ${detail}`) : ""));
}

export function renderWrappedToolCall(theme: ThemeLike | undefined, tool: string, parts: Array<string | undefined | false>) {
  const detail = parts.filter(Boolean).join(" · ");
  const content = themeFg(theme, "toolTitle", tool) + (detail ? themeFg(theme, "muted", ` ${detail}`) : "");
  return {
    render(width: number): string[] {
      return wrapAnsi(content, Math.max(1, width));
    },
    invalidate() {},
  };
}

export function renderToolOutcome(theme: ThemeLike | undefined, outcome: ToolOutcome, parts: Array<string | undefined | false>) {
  const icon = outcome === "success" ? "✓" : outcome === "warning" ? "⚠" : "✗";
  const color = outcome === "success" ? "success" : outcome === "warning" ? "warning" : "error";
  const detail = parts.filter(Boolean).join(" · ") || (outcome === "error" ? "failed" : "done");
  return toolHint(themeFg(theme, color, `${icon} `) + themeFg(theme, "muted", detail));
}

export function toolErrorMessage(result: any, fallback: string): string {
  const text = result?.content?.find?.((item: any) => item?.type === "text" && typeof item.text === "string")?.text;
  const firstLine = typeof text === "string" ? text.trim().split(/\r?\n/, 1)[0] : "";
  return firstLine || fallback;
}

export function formatLines(lines: unknown): string | undefined {
  if (typeof lines !== "number" || !Number.isFinite(lines) || lines < 0) return undefined;
  return `${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"}`;
}

export function formatResults(results: unknown, requested = false): string | undefined {
  if (typeof results !== "number" || !Number.isFinite(results) || results < 0) return undefined;
  const count = Math.floor(results);
  return `${count.toLocaleString()} ${requested ? "requested" : count === 1 ? "result" : "results"}`;
}
