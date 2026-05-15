import { getCopilotToken } from "../auth.ts";
import { fetchWithTimeout } from "../http.ts";
import type { QuotaFetchOptions, QuotaSnapshot, QuotaWindow } from "../types.ts";
import { clampPercent, formatResetTime } from "../util.ts";

const PROVIDER = "Copilot";
const PROVIDER_ID = "copilot" as const;

function snapshot(windows: QuotaWindow[], options: QuotaFetchOptions | undefined, raw?: unknown, error?: string): QuotaSnapshot {
  return { provider: PROVIDER, providerId: PROVIDER_ID, windows, error, fetchedAt: options?.now?.() ?? Date.now(), raw };
}

export function parseCopilotUsageResponse(data: any, now = Date.now()): QuotaWindow[] {
  const resetDate = data?.quota_reset_date_utc ? new Date(data.quota_reset_date_utc) : undefined;
  const resetsIn = resetDate ? formatResetTime(resetDate, now) : undefined;
  const windows: QuotaWindow[] = [];
  if (data?.quota_snapshots?.premium_interactions) {
    const w = data.quota_snapshots.premium_interactions;
    windows.push({ label: "Premium", usedPercent: clampPercent(100 - (w.percent_remaining || 0)), resetsIn, raw: w });
  }
  if (data?.quota_snapshots?.chat && !data.quota_snapshots.chat.unlimited) {
    const w = data.quota_snapshots.chat;
    windows.push({ label: "Chat", usedPercent: clampPercent(100 - (w.percent_remaining || 0)), resetsIn, raw: w });
  }
  return windows;
}

export async function fetchCopilotUsage(options: QuotaFetchOptions = {}): Promise<QuotaSnapshot> {
  const token = getCopilotToken();
  if (!token) return snapshot([], options, undefined, "no-auth");
  try {
    const res = await fetchWithTimeout("https://api.github.com/copilot_internal/user", {
      headers: {
        "Editor-Version": "vscode/1.96.2",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
        Accept: "application/json",
        Authorization: `token ${token}`,
      },
    }, options.timeoutMs, options.fetchImpl);
    if (!res.ok) return snapshot([], options, undefined, `HTTP ${res.status}`);
    const data = (await res.json()) as any;
    return snapshot(parseCopilotUsageResponse(data, options.now?.() ?? Date.now()), options, data);
  } catch (error) {
    return snapshot([], options, undefined, String(error));
  }
}

export const copilotQuotaAdapter = {
  id: PROVIDER_ID,
  label: PROVIDER,
  getCredentials: () => {
    const token = getCopilotToken();
    return token ? { token } : undefined;
  },
  fetchUsage: fetchCopilotUsage,
};
