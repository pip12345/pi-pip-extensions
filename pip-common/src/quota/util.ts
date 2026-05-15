export function clampPercent(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export function normalizePercent(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return clampPercent(n <= 1 ? n * 100 : n);
}

export function formatResetTime(date: Date, now = Date.now()): string | undefined {
  const ms = date.getTime() - now;
  if (!Number.isFinite(ms)) return undefined;
  if (ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60_000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes - days * 60 * 24) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d${hours ? `${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${mins ? `${mins}m` : ""}`;
  return `${mins}m`;
}

export function getWindowLabel(durationMs: number | undefined, fallback: string): string {
  if (!durationMs) return fallback;
  const hours = Math.round(durationMs / 3_600_000);
  if (hours > 0 && hours < 24) return `${hours}h`;
  const days = Math.round(durationMs / 86_400_000);
  if (days >= 6 && days <= 8) return "Week";
  return fallback;
}
