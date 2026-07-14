import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cacheHitRateFromUsage, normalizeUsage, pipPath, promptTokensFromUsage } from "pip-common";
import { buildSessionContext } from "../session-context.ts";

export interface TokenBreakdown {
  /** Human-facing total prompt-side input: uncached input + cache read + cache write. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cache: number;
  total: number;
  cost?: number;
  latestCacheHitRate?: number;
}

export const cacheHitRate = cacheHitRateFromUsage;

export function tokenBreakdownFromUsage(usage: any): TokenBreakdown | undefined {
  const tokens = normalizeUsage(usage);
  return tokens ? { ...tokens, input: promptTokensFromUsage(tokens), latestCacheHitRate: cacheHitRateFromUsage(tokens) } : undefined;
}

export function addTokenBreakdown(total: TokenBreakdown, next: TokenBreakdown): void {
  total.input += next.input;
  total.output += next.output;
  total.cacheRead += next.cacheRead;
  total.cacheWrite += next.cacheWrite;
  total.cache += next.cache;
  total.total += next.total;
  total.cost = (total.cost ?? 0) + (next.cost ?? 0);
  if (next.latestCacheHitRate !== undefined) total.latestCacheHitRate = next.latestCacheHitRate;
}

export function getBranchTokens(ctx: any): TokenBreakdown | undefined {
  const entries = ctx.sessionManager.getEntries();
  const leafId = ctx.sessionManager.getLeafId();
  const context = buildSessionContext(entries, leafId);
  const total: TokenBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cache: 0, total: 0, cost: 0 };
  let found = false;

  for (const message of context.messages) {
    if (message?.role !== "assistant") continue;
    const usage = tokenBreakdownFromUsage(message.usage);
    if (!usage) continue;
    addTokenBreakdown(total, usage);
    found = true;
  }

  return found ? total : undefined;
}

function emptyBreakdown(): TokenBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cache: 0, total: 0, cost: 0 };
}

function sessionFile(ctx: any): string | undefined {
  return ctx?.sessionManager?.getSessionFile?.() ?? ctx?.sessionManager?.sessionFile;
}

function linkedSessionFiles(parentSessionFile: string | undefined): Set<string> {
  const files = new Set<string>();
  if (!parentSessionFile) return files;
  files.add(parentSessionFile);
  const parentsDir = pipPath("subagents", "parents");
  if (!existsSync(parentsDir)) return files;
  for (const dirent of readdirSync(parentsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const path = join(parentsDir, dirent.name, "runs.json");
    if (!existsSync(path)) continue;
    try {
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (record?.parentSessionFile !== parentSessionFile && record?.parentSessionKey !== parentSessionFile) continue;
      for (const run of Array.isArray(record.runs) ? record.runs : []) {
        if (typeof run?.sessionFile === "string") files.add(run.sessionFile);
      }
    } catch {}
  }
  return files;
}

function eventDays(): string[] {
  const dir = pipPath("usage", "events");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name);
}

let historicalCache: { key: string; expiresAt: number; tokens: TokenBreakdown | undefined } | undefined;

export function getHistoricalSessionTokens(ctx: any, options: { fresh?: boolean } = {}): TokenBreakdown | undefined {
  const sessions = linkedSessionFiles(sessionFile(ctx));
  if (!sessions.size) return undefined;
  const cacheKey = [...sessions].sort().join("\0");
  const now = Date.now();
  if (!options.fresh && historicalCache?.key === cacheKey && historicalCache.expiresAt > now) return historicalCache.tokens ? { ...historicalCache.tokens } : undefined;
  const total = emptyBreakdown();
  const seen = new Set<string>();
  let found = false;
  let latestTs = -Infinity;
  let latestCacheHitRate: number | undefined;
  for (const day of eventDays()) {
    const dayDir = pipPath("usage", "events", day);
    for (const file of readdirSync(dayDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const path = join(dayDir, file.name);
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (!sessions.has(event?.sessionFile)) continue;
          const dedupe = typeof event.id === "string" && event.id ? event.id : createHash("sha1").update(line).digest("hex");
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          const usage = tokenBreakdownFromUsage(event);
          if (!usage) continue;
          const candidateTs = typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : -Infinity;
          const candidateCacheHitRate = usage.latestCacheHitRate;
          addTokenBreakdown(total, usage);
          if (candidateCacheHitRate !== undefined && candidateTs >= latestTs) {
            latestTs = candidateTs;
            latestCacheHitRate = candidateCacheHitRate;
          }
          if (latestCacheHitRate !== undefined) total.latestCacheHitRate = latestCacheHitRate;
          else delete total.latestCacheHitRate;
          found = true;
        } catch {}
      }
    }
  }
  const tokens = found ? total : undefined;
  historicalCache = { key: cacheKey, expiresAt: now + 1000, tokens: tokens ? { ...tokens } : undefined };
  return tokens;
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
    latestCacheHitRate: to.latestCacheHitRate,
  };
}
