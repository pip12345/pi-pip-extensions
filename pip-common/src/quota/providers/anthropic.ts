import { getClaudeToken } from "../auth.ts";
import { fetchWithTimeout, joinUrlPath } from "../http.ts";
import type { QuotaFetchOptions, QuotaSnapshot, QuotaWindow } from "../types.ts";
import { normalizePercent, formatResetTime } from "../util.ts";

const PROVIDER = "Claude";
const PROVIDER_ID = "anthropic" as const;
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_USAGE_PATH = "/api/oauth/usage";

function snapshot(windows: QuotaWindow[], options: QuotaFetchOptions | undefined, raw?: unknown, error?: string): QuotaSnapshot {
  return { provider: PROVIDER, providerId: PROVIDER_ID, windows, error, fetchedAt: options?.now?.() ?? Date.now(), raw };
}

export function parseAnthropicUsageResponse(data: any, now = Date.now()): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  if (data?.five_hour?.utilization !== undefined) {
    windows.push({ label: "5h", usedPercent: normalizePercent(data.five_hour.utilization), resetsIn: data.five_hour.resets_at ? formatResetTime(new Date(data.five_hour.resets_at), now) : undefined, raw: data.five_hour });
  }
  if (data?.seven_day?.utilization !== undefined) {
    windows.push({ label: "Week", usedPercent: normalizePercent(data.seven_day.utilization), resetsIn: data.seven_day.resets_at ? formatResetTime(new Date(data.seven_day.resets_at), now) : undefined, raw: data.seven_day });
  }
  return windows;
}

export function resolveAnthropicUsageUrl(modelBaseUrl?: string): string {
  return joinUrlPath(modelBaseUrl?.trim() || DEFAULT_ANTHROPIC_BASE_URL, ANTHROPIC_USAGE_PATH);
}

export async function fetchAnthropicUsage(options: QuotaFetchOptions = {}): Promise<QuotaSnapshot> {
  const token = options.credentials === undefined ? getClaudeToken() : options.credentials?.token;
  if (!token) return snapshot([], options, undefined, "no-auth");
  try {
    const res = await fetchWithTimeout(resolveAnthropicUsageUrl(options.modelBaseUrl), {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    }, options.timeoutMs, options.fetchImpl);
    if (!res.ok) return snapshot([], options, undefined, `HTTP ${res.status}`);
    const data = (await res.json()) as any;
    return snapshot(parseAnthropicUsageResponse(data, options.now?.() ?? Date.now()), options, data);
  } catch (error) {
    return snapshot([], options, undefined, String(error));
  }
}

export const anthropicQuotaAdapter = {
  id: PROVIDER_ID,
  label: PROVIDER,
  getCredentials: () => {
    const token = getClaudeToken();
    return token ? { token } : undefined;
  },
  fetchUsage: fetchAnthropicUsage,
};
