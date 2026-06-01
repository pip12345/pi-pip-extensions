export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cache: number;
  total: number;
  cost: number;
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cache: 0, total: 0, cost: 0 };
}

export function numberFrom(obj: any, keys: string[]): number {
  for (const key of keys) {
    const value = key.includes(".") ? key.split(".").reduce((o: any, p) => o?.[p], obj) : obj?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  }
  return 0;
}

export function normalizeUsage(usage: any): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = numberFrom(usage, ["input", "inputTokens", "promptTokens", "prompt_tokens"]);
  const output = numberFrom(usage, ["output", "outputTokens", "completionTokens", "completion_tokens"]);
  const cacheRead = numberFrom(usage, [
    "cacheRead",
    "cache_read",
    "cachedTokens",
    "cached_tokens",
    "cacheReadInputTokens",
    "cache_read_input_tokens",
    "prompt_tokens_details.cached_tokens",
  ]);
  const cacheWrite = numberFrom(usage, [
    "cacheWrite",
    "cache_write",
    "cacheCreationInputTokens",
    "cache_creation_input_tokens",
    "cacheWriteInputTokens",
    "cache_write_input_tokens",
  ]);
  const componentTotal = input + output + cacheRead + cacheWrite;
  const total = numberFrom(usage, ["totalTokens", "total", "total_tokens"]) || componentTotal;
  const cost = numberFrom(usage, ["cost.total", "cost"]);
  if (total <= 0 && componentTotal <= 0) return undefined;
  return { input, output, cacheRead, cacheWrite, cache: cacheRead + cacheWrite, total, cost };
}

export function addUsage(target: TokenUsage, next: TokenUsage): void {
  target.input += next.input;
  target.output += next.output;
  target.cacheRead += next.cacheRead;
  target.cacheWrite += next.cacheWrite;
  target.cache += next.cache;
  target.total += next.total;
  target.cost += next.cost;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${Math.round(tokens)}`;
}

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0";
  if (cost < 0.001) return `$${cost.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (cost < 1) return `$${cost.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${cost.toFixed(2)}`;
}

export function formatCompactUsage(usage: TokenUsage | undefined, options: { includeCost?: boolean } = {}): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.input) parts.push(`↓:${formatTokenCount(usage.input)}`);
  if (usage.output) parts.push(`↑:${formatTokenCount(usage.output)}`);
  if (usage.cache) parts.push(`↻:${formatTokenCount(usage.cache)}`);
  const text = parts.join(" ");
  if (options.includeCost && usage.cost) return text ? `${text} · ${formatCost(usage.cost)}` : formatCost(usage.cost);
  return text;
}
