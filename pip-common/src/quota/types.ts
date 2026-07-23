export type QuotaProvider = "codex" | "anthropic" | "copilot";
export type QuotaProviderSetting = QuotaProvider | "auto" | "off";

export interface QuotaCredentials {
  token: string;
  accountId?: string;
}

export interface QuotaWindow {
  label: string;
  usedPercent: number;
  resetsIn?: string;
  raw?: unknown;
}

export interface QuotaSnapshot {
  provider: string;
  providerId: QuotaProvider;
  windows: QuotaWindow[];
  error?: string;
  fetchedAt: number;
  raw?: unknown;
}

export interface QuotaFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /** Effective Pi model.baseUrl. Quota adapters append provider-specific usage paths to it. */
  modelBaseUrl?: string;
  /** Resolved credentials for the active model. null explicitly disables adapter fallback lookup. */
  credentials?: QuotaCredentials | null;
}

export interface QuotaProviderAdapter {
  id: QuotaProvider;
  label: string;
  getCredentials(): QuotaCredentials | undefined;
  fetchUsage(options?: QuotaFetchOptions): Promise<QuotaSnapshot>;
}
