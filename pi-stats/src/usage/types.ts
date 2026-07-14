import type { TokenUsage as Tokens } from "pip-common";

export type RangeKey = "today" | "7d" | "30d" | "all";
export type GroupBy = "model" | "provider" | "day";

export interface GlobalUsageEvent extends Tokens {
  id?: string;
  ts: number;
  cwd?: string;
  sessionFile?: string;
  provider: string;
  model: string;
}

export interface UsageBucket extends Tokens {
  day: string;
  provider: string;
  model: string;
  turns: number;
  firstTs: number;
  lastTs: number;
}

export interface UsageRollups {
  version: 1;
  updatedAt: number;
  buckets: Record<string, UsageBucket>;
  compactedEventSources?: string[];
  migratedLegacySources?: string[];
}

export interface GlobalRow extends Tokens {
  key: string;
  turns: number;
  lastTs: number;
}
