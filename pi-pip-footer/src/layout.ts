import { clampPercent, truncateToWidth, visibleWidth } from "pip-common";
import { BAR_EMPTY, BAR_FILLED } from "./constants.ts";

export function fitSegment(width: number, variants: string[]): string {
  const safeWidth = Math.max(1, width);
  for (const variant of variants) {
    if (visibleWidth(variant) <= safeWidth) return variant;
  }
  return truncateToWidth(variants[variants.length - 1] || "", safeWidth);
}

export function wrapSegments(segments: string[], width: number, sep: string): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let current = "";

  for (const segment of segments.filter(Boolean)) {
    const fitted = truncateToWidth(segment, safeWidth);
    if (!current) {
      current = fitted;
      continue;
    }
    const candidate = `${current}${sep}${fitted}`;
    if (visibleWidth(candidate) <= safeWidth) current = candidate;
    else {
      lines.push(truncateToWidth(current, safeWidth));
      current = fitted;
    }
  }

  if (current) lines.push(truncateToWidth(current, safeWidth));
  return lines;
}

export function padEndVisible(text: string, targetWidth: number): string {
  const gap = Math.max(0, targetWidth - visibleWidth(text));
  return `${text}${" ".repeat(gap)}`;
}

export function joinRight(left: string, right: string | undefined, width: number): string {
  if (!right?.trim()) return left;
  const leftWidth = visibleWidth(left);
  if (leftWidth >= width) return left;
  const minGap = 2;
  const rightMargin = 1;
  const availableRight = width - leftWidth - minGap - rightMargin;
  if (availableRight <= 0) return left;
  const fittedRight = truncateToWidth(right, availableRight);
  if (!fittedRight.trim()) return left;
  const gap = Math.max(minGap, width - rightMargin - leftWidth - visibleWidth(fittedRight));
  return `${left}${" ".repeat(gap)}${fittedRight}`;
}

export function renderBar(usedPercent: number, width: number, theme: any, kind: "quota" | "ctx" = "quota"): string {
  const clamped = clampPercent(usedPercent);
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  const color = kind === "ctx" ? (clamped >= 90 ? "error" : clamped >= 70 ? "warning" : "accent") : clamped >= 92 ? "error" : clamped >= 85 ? "warning" : "accent";
  return theme.fg(color, BAR_FILLED.repeat(filled)) + theme.fg("dim", BAR_EMPTY.repeat(empty));
}
