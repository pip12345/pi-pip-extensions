export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cache: number;
  total: number;
  cost: number;
}

export type SessionUsageKind = "assistant" | "tool" | "compaction" | "branch_summary";

export interface SessionUsageRecord {
  kind: SessionUsageKind;
  usage: TokenUsage;
  entryId?: string;
  timestamp?: number;
  provider?: string;
  model?: string;
  toolName?: string;
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

function usageTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Project a persisted Pi session entry into its independently billable usage.
 * Context estimates such as compaction.tokensBefore are intentionally excluded.
 */
export function sessionUsageRecord(entry: any): SessionUsageRecord | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const entryId = typeof entry.id === "string" ? entry.id : undefined;
  const message = entry.type === "message" ? entry.message : undefined;

  if (message?.role === "assistant") {
    const usage = normalizeUsage(message.usage);
    if (!usage) return undefined;
    return {
      kind: "assistant",
      usage,
      entryId,
      timestamp: usageTimestamp(message.timestamp) ?? usageTimestamp(entry.timestamp),
      provider: typeof message.provider === "string" ? message.provider : undefined,
      model: typeof (message.responseModel ?? message.model) === "string" ? message.responseModel ?? message.model : undefined,
    };
  }

  if (message?.role === "toolResult") {
    const usage = normalizeUsage(message.usage);
    if (!usage) return undefined;
    return {
      kind: "tool",
      usage,
      entryId,
      timestamp: usageTimestamp(message.timestamp) ?? usageTimestamp(entry.timestamp),
      toolName: typeof message.toolName === "string" ? message.toolName : undefined,
    };
  }

  if (entry.type === "compaction" || entry.type === "branch_summary") {
    const usage = normalizeUsage(entry.usage);
    if (!usage) return undefined;
    return {
      kind: entry.type,
      usage,
      entryId,
      timestamp: usageTimestamp(entry.timestamp),
    };
  }

  return undefined;
}

export function sessionUsageRecords(entries: any[]): SessionUsageRecord[] {
  return (entries ?? []).map(sessionUsageRecord).filter((record): record is SessionUsageRecord => Boolean(record));
}

export function sumSessionUsage(entries: any[]): TokenUsage | undefined {
  const total = emptyUsage();
  let found = false;
  for (const record of sessionUsageRecords(entries)) {
    addUsage(total, record.usage);
    found = true;
  }
  return found ? total : undefined;
}

export type PromptTokenParts = Pick<TokenUsage, "input" | "cacheRead" | "cacheWrite">;

/**
 * Total prompt-side/input tokens for Pi-normalized usage.
 *
 * Pi normalizes cache reads/writes as separate prompt-side token buckets, matching
 * Anthropic's accounting: total input = input + cache_creation + cache_read.
 * Keep raw `input` as uncached input for pricing; use this helper for human-facing
 * prompt/input totals.
 */
export function promptTokensFromUsage(usage: PromptTokenParts | undefined): number {
  if (!usage) return 0;
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** Prompt tokens processed fresh in this request, including tokens written to cache. */
export function freshInputTokensFromUsage(usage: PromptTokenParts | undefined): number {
  if (!usage) return 0;
  return usage.input + usage.cacheWrite;
}

export function cacheHitRateFromUsage(usage: PromptTokenParts | undefined): number | undefined {
  const promptTokens = promptTokensFromUsage(usage);
  return usage && promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
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

export function formatCompactUsage(usage: TokenUsage | undefined, options: { includeCost?: boolean; inputMode?: "fresh" | "prompt" | "raw" } = {}): string {
  if (!usage) return "";
  const parts: string[] = [];
  const inputTokens = options.inputMode === "prompt"
    ? promptTokensFromUsage(usage)
    : options.inputMode === "raw"
      ? usage.input
      : freshInputTokensFromUsage(usage);
  if (inputTokens) parts.push(`↓:${formatTokenCount(inputTokens)}`);
  if (usage.output) parts.push(`↑:${formatTokenCount(usage.output)}`);
  if (usage.cacheRead) parts.push(`↻:${formatTokenCount(usage.cacheRead)}`);
  const text = parts.join(" ");
  if (options.includeCost && usage.cost) return text ? `${text} · ${formatCost(usage.cost)}` : formatCost(usage.cost);
  return text;
}
