import type { ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { addUsage, emptyUsage, normalizeUsage, type TokenUsage } from "../../pip-common/index.ts";

/** Pi's usage shape for tool results. Pi counts it in session totals, the footer, and pi-stats. */
export type PiUsage = NonNullable<ToolResultEventResult["usage"]>;

export function hasUsage(usage: TokenUsage): boolean {
  return usage.total > 0 || usage.cost > 0;
}

export function subtractUsage(total: TokenUsage, base: TokenUsage): TokenUsage {
  return {
    input: Math.max(0, total.input - base.input),
    output: Math.max(0, total.output - base.output),
    cacheRead: Math.max(0, total.cacheRead - base.cacheRead),
    cacheWrite: Math.max(0, total.cacheWrite - base.cacheWrite),
    cache: Math.max(0, total.cache - base.cache),
    total: Math.max(0, total.total - base.total),
    cost: Math.max(0, total.cost - base.cost),
  };
}

/**
 * Adds child usage to an existing tool-result usage. Child usage only keeps the total cost, so the
 * per-category cost fields keep the existing values and the total includes both.
 */
export function addToPiUsage(base: PiUsage | undefined, extra: TokenUsage): PiUsage {
  const sum = normalizeUsage(base) ?? emptyUsage();
  addUsage(sum, extra);
  return {
    input: sum.input,
    output: sum.output,
    cacheRead: sum.cacheRead,
    cacheWrite: sum.cacheWrite,
    totalTokens: sum.total,
    cost: { input: base?.cost.input ?? 0, output: base?.cost.output ?? 0, cacheRead: base?.cost.cacheRead ?? 0, cacheWrite: base?.cost.cacheWrite ?? 0, total: sum.cost },
  };
}
