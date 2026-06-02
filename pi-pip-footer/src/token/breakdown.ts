import { normalizeUsage } from "../../../pip-common/index.ts";
import { buildSessionContext } from "../session-context.ts";

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cache: number;
  total: number;
  cost?: number;
}

export function addTokenBreakdown(total: TokenBreakdown, next: TokenBreakdown): void {
  total.input += next.input;
  total.output += next.output;
  total.cacheRead += next.cacheRead;
  total.cacheWrite += next.cacheWrite;
  total.cache += next.cache;
  total.total += next.total;
  total.cost = (total.cost ?? 0) + (next.cost ?? 0);
}

export function getBranchTokens(ctx: any): TokenBreakdown | undefined {
  const entries = ctx.sessionManager.getEntries();
  const leafId = ctx.sessionManager.getLeafId();
  const context = buildSessionContext(entries, leafId);
  const total: TokenBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cache: 0, total: 0, cost: 0 };
  let found = false;

  for (const message of context.messages) {
    if (message?.role !== "assistant") continue;
    const usage = normalizeUsage(message.usage);
    if (!usage) continue;
    addTokenBreakdown(total, usage);
    found = true;
  }

  return found ? total : undefined;
}

export function diffTokenBreakdown(previous: TokenBreakdown | undefined, next: TokenBreakdown): TokenBreakdown | undefined {
  if (!previous) return next.total > 0 ? { ...next } : undefined;

  const input = Math.max(0, next.input - previous.input);
  const output = Math.max(0, next.output - previous.output);
  const cacheRead = Math.max(0, next.cacheRead - previous.cacheRead);
  const cacheWrite = Math.max(0, next.cacheWrite - previous.cacheWrite);
  const total = Math.max(0, next.total - previous.total);
  const cache = cacheRead + cacheWrite;
  const cost = Math.max(0, (next.cost ?? 0) - (previous.cost ?? 0));

  if (input + output + cache + total + cost <= 0) return undefined;
  return { input, output, cacheRead, cacheWrite, cache, total, cost };
}

export function interpolateTokenBreakdown(from: TokenBreakdown, to: TokenBreakdown, progress: number): TokenBreakdown {
  const p = Math.max(0, Math.min(1, progress));
  const lerpRaw = (a: number, b: number) => a + (b - a) * p;
  const lerp = (a: number, b: number) => Math.round(lerpRaw(a, b));
  const cache = lerp(from.cache, to.cache);
  return {
    input: lerp(from.input, to.input),
    output: lerp(from.output, to.output),
    cacheRead: 0,
    cacheWrite: 0,
    cache,
    total: lerp(from.total, to.total),
    cost: from.cost != null || to.cost != null ? lerpRaw(from.cost ?? 0, to.cost ?? 0) : undefined,
  };
}
