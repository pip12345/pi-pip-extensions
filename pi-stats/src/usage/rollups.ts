import type { GlobalRow, GlobalUsageEvent, GroupBy, RangeKey, UsageBucket, UsageRollups } from "./types.ts";

export function emptyRollups(): UsageRollups {
  return { version: 1, updatedAt: 0, buckets: {} };
}

export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function rangeStart(range: RangeKey): number {
  const now = new Date();
  if (range === "all") return 0;
  if (range === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = range === "7d" ? 7 : 30;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

export function bucketKey(day: string, provider: string, model: string): string {
  return `${day}|${provider}|${model}`;
}

export function addEventToRollups(rollups: UsageRollups, event: GlobalUsageEvent): void {
  const provider = event.provider || "unknown";
  const model = event.model || "unknown";
  const ts = event.ts || Date.now();
  const day = dayKey(ts);
  const key = bucketKey(day, provider, model);
  const bucket = rollups.buckets[key] ?? {
    day,
    provider,
    model,
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cache: 0,
    total: 0,
    cost: 0,
    firstTs: ts,
    lastTs: ts,
  };
  bucket.turns += 1;
  bucket.input += event.input;
  bucket.output += event.output;
  bucket.cacheRead += event.cacheRead;
  bucket.cacheWrite += event.cacheWrite;
  bucket.cache += event.cache;
  bucket.total += event.total;
  bucket.cost += event.cost;
  bucket.firstTs = Math.min(bucket.firstTs, ts);
  bucket.lastTs = Math.max(bucket.lastTs, ts);
  rollups.buckets[key] = bucket;
}

export function mergeRollups(target: UsageRollups, source: UsageRollups): void {
  for (const bucket of Object.values(source.buckets)) {
    const key = bucketKey(bucket.day, bucket.provider, bucket.model);
    const existing = target.buckets[key];
    if (!existing) {
      target.buckets[key] = { ...bucket };
      continue;
    }
    existing.turns += bucket.turns;
    existing.input += bucket.input;
    existing.output += bucket.output;
    existing.cacheRead += bucket.cacheRead;
    existing.cacheWrite += bucket.cacheWrite;
    existing.cache += bucket.cache;
    existing.total += bucket.total;
    existing.cost += bucket.cost;
    existing.firstTs = Math.min(existing.firstTs, bucket.firstTs);
    existing.lastTs = Math.max(existing.lastTs, bucket.lastTs);
  }
}

function bucketInRange(bucket: UsageBucket, range: RangeKey): boolean {
  if (range === "all") return true;
  if (range === "today") return bucket.day === dayKey(Date.now());
  return bucket.day >= dayKey(rangeStart(range));
}

export function groupGlobal(rollups: UsageRollups, range: RangeKey, groupBy: GroupBy, search: string): GlobalRow[] {
  const q = search.trim().toLowerCase();
  const map = new Map<string, GlobalRow>();
  for (const bucket of Object.values(rollups.buckets)) {
    if (!bucketInRange(bucket, range)) continue;
    const hay = `${bucket.provider}/${bucket.model}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const key = groupBy === "provider" ? bucket.provider : groupBy === "day" ? bucket.day : `${bucket.provider}/${bucket.model}`;
    const row = map.get(key) ?? { key, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cache: 0, total: 0, cost: 0, lastTs: 0 };
    row.turns += bucket.turns;
    row.input += bucket.input;
    row.output += bucket.output;
    row.cacheRead += bucket.cacheRead;
    row.cacheWrite += bucket.cacheWrite;
    row.cache += bucket.cache;
    row.total += bucket.total;
    row.cost += bucket.cost;
    row.lastTs = Math.max(row.lastTs, bucket.lastTs);
    map.set(key, row);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}
