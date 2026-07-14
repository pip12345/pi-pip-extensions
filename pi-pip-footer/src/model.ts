import { renderRegisteredFooterItems, stripAnsi } from "pip-common";
import { buildSessionContext } from "./session-context.ts";

export function renderModelLine(ctx: any, theme: any): string {
  const model = ctx.model;
  const modelName = model?.id?.split("/").pop() || "no-model";
  const entries = ctx.sessionManager?.getEntries?.() ?? [];
  const thinking = buildSessionContext(entries, ctx.sessionManager?.getLeafId?.()).thinkingLevel ?? model?.reasoning?.effort;
  const base = theme.fg("muted", modelName);
  return thinking && thinking !== "off" ? `${base}${theme.fg("dim", "/")}${theme.fg("accent", thinking)}` : base;
}

export function renderToolsExpandedWarning(ctx: any, theme: any): string {
  return ctx.ui?.getToolsExpanded?.() ? theme.fg("warning", "tools expanded") : "";
}

export function renderExtensionStatuses(footerData: any): string {
  const statuses = footerData?.getExtensionStatuses?.();
  if (!statuses?.size) return "";
  return [...statuses.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([, text]) => stripAnsi(String(text ?? "")).replace(/[\r\n\t\x00-\x1f\x7f]/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

export { renderRegisteredFooterItems };
