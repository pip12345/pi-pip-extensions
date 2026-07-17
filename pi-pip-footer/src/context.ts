import { formatTokenCount } from "../../pip-common/index.ts";
import { fitSegment, renderBar } from "./layout.ts";
import { getBranchTokens } from "./token/breakdown.ts";

export function getContextInfo(ctx: any): { percentage: number | null; used: number | null; total: number } {
  const direct = ctx.getContextUsage?.();
  const modelWindow = direct?.contextWindow ?? ctx.model?.contextWindow ?? 0;

  if (direct) {
    if (!modelWindow) return { percentage: null, used: null, total: 0 };
    if (typeof direct.tokens !== "number") return { percentage: null, used: null, total: modelWindow };
    const percentage = typeof direct.percent === "number" ? direct.percent : (direct.tokens / modelWindow) * 100;
    return { percentage, used: direct.tokens, total: modelWindow };
  }

  if (!modelWindow) return { percentage: 0, used: 0, total: 0 };
  const tokens = getBranchTokens(ctx)?.total ?? 0;
  return { percentage: tokens ? (tokens / modelWindow) * 100 : 0, used: tokens, total: modelWindow };
}

export function renderContextLine(ctx: any, width: number, theme: any): string {
  const info = getContextInfo(ctx);
  const label = theme.fg("dim", "ctx ");
  if (!info.total) return `${label}${theme.fg("dim", "unknown")}`;
  if (info.used == null || info.percentage == null) {
    return fitSegment(width, [
      `${label}${renderBar(0, 10, theme, "ctx")} ${theme.fg("accent", `?/${formatTokenCount(info.total)}`)}`,
      `${label}${theme.fg("accent", `?/${formatTokenCount(info.total)}`)}`,
      `${label}${theme.fg("dim", "unknown")}`,
    ]);
  }
  return fitSegment(width, [
    `${label}${renderBar(info.percentage, 10, theme, "ctx")} ${theme.fg("accent", `${formatTokenCount(info.used)}/${formatTokenCount(info.total)}`)}`,
    `${label}${renderBar(info.percentage, 10, theme, "ctx")} ${theme.fg("accent", `${Math.round(info.percentage)}%`)}`,
    `${label}${renderBar(info.percentage, 8, theme, "ctx")}`,
  ]);
}
