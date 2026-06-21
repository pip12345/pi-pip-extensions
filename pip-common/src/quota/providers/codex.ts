import { getCodexCredentials } from "../auth.ts";
import { fetchWithTimeout, joinUrlPath } from "../http.ts";
import type { QuotaCredentials, QuotaFetchOptions, QuotaSnapshot, QuotaWindow } from "../types.ts";
import { clampPercent, formatResetTime, getWindowLabel } from "../util.ts";

const PROVIDER = "Codex";
const PROVIDER_ID = "codex" as const;
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_USAGE_PATH = "/wham/usage";

function snapshot(windows: QuotaWindow[], options: QuotaFetchOptions | undefined, raw?: unknown, error?: string): QuotaSnapshot {
  return { provider: PROVIDER, providerId: PROVIDER_ID, windows, error, fetchedAt: options?.now?.() ?? Date.now(), raw };
}

export function parseCodexUsageResponse(data: any, now = Date.now()): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  if (data?.rate_limit?.primary_window) {
    const w = data.rate_limit.primary_window;
    windows.push({
      label: getWindowLabel(typeof w.limit_window_seconds === "number" ? w.limit_window_seconds * 1000 : undefined, "5h"),
      usedPercent: clampPercent(w.used_percent || 0),
      resetsIn: w.reset_at ? formatResetTime(new Date(w.reset_at * 1000), now) : undefined,
      raw: w,
    });
  }
  if (data?.rate_limit?.secondary_window) {
    const w = data.rate_limit.secondary_window;
    windows.push({
      label: getWindowLabel(typeof w.limit_window_seconds === "number" ? w.limit_window_seconds * 1000 : undefined, "Week"),
      usedPercent: clampPercent(w.used_percent || 0),
      resetsIn: w.reset_at ? formatResetTime(new Date(w.reset_at * 1000), now) : undefined,
      raw: w,
    });
  }
  return windows;
}

export function getCodexQuotaCredentials(): QuotaCredentials | undefined {
  return getCodexCredentials();
}

export function resolveCodexUsageUrl(modelBaseUrl?: string): string {
  return joinUrlPath(modelBaseUrl?.trim() || DEFAULT_CODEX_BASE_URL, CODEX_USAGE_PATH);
}

export async function fetchCodexUsage(options: QuotaFetchOptions = {}): Promise<QuotaSnapshot> {
  const creds = getCodexQuotaCredentials();
  if (!creds) return snapshot([], options, undefined, "no-auth");
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${creds.token}`, "User-Agent": "pi-agent", Accept: "application/json" };
    if (creds.accountId) headers["ChatGPT-Account-Id"] = creds.accountId;
    const res = await fetchWithTimeout(resolveCodexUsageUrl(options.modelBaseUrl), { method: "GET", headers }, options.timeoutMs, options.fetchImpl);
    if (!res.ok) return snapshot([], options, undefined, `HTTP ${res.status}`);
    const data = (await res.json()) as any;
    return snapshot(parseCodexUsageResponse(data, options.now?.() ?? Date.now()), options, data);
  } catch (error) {
    return snapshot([], options, undefined, String(error));
  }
}

export const codexQuotaAdapter = {
  id: PROVIDER_ID,
  label: PROVIDER,
  getCredentials: getCodexQuotaCredentials,
  fetchUsage: fetchCodexUsage,
};
