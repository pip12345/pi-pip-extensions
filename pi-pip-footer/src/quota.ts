import { formatResetTime, getWindowLabel, type QuotaSnapshot as UsageSnapshot, type QuotaWindow as RateWindow } from "../../pip-common/index.ts";
import { fitSegment, padEndVisible, renderBar, wrapSegments } from "./layout.ts";

export function renderUsageWindow(window: RateWindow, theme: any, barWidth = 10, includeReset = true): string {
  const dim = (s: string) => theme.fg("dim", s);
  const rawLabel = window.label.toLowerCase() === "week" ? "7d" : window.label.toLowerCase();
  const label = padEndVisible(rawLabel, 3);
  const reset = includeReset && window.resetsIn ? ` ${dim(`↻ ${window.resetsIn}`)}` : "";
  return `${dim(label)} ${renderBar(window.usedPercent, barWidth, theme)} ${dim(`${Math.round(window.usedPercent)}%`)}${reset}`;
}

export function renderUsageLine(usage: UsageSnapshot | null, width: number, theme: any, labelWidth = 10, firstWindowWidth = 0): string[] {
  if (!usage) return [];
  const sep = "   ";
  const provider = padEndVisible(theme.fg("accent", usage.provider.toLowerCase()), labelWidth);
  if (!usage.windows.length) {
    if (!usage.error) return [];
    return wrapSegments([provider, theme.fg("warning", "usage offline")], width, sep);
  }
  const segments = [provider];
  for (const [index, window] of usage.windows.entries()) {
    const segment = fitSegment(width, [
      renderUsageWindow(window, theme, 10, true),
      renderUsageWindow(window, theme, 8, true),
      renderUsageWindow(window, theme, 8, false),
      renderUsageWindow(window, theme, 5, false),
    ]);
    segments.push(index === 0 && firstWindowWidth > 0 ? padEndVisible(segment, firstWindowWidth) : segment);
  }
  return wrapSegments(segments, width, sep);
}

export const quotaTestExports = { formatResetTime, getWindowLabel };
