import { createHash } from "node:crypto";
import { anthropicQuotaAdapter } from "./providers/anthropic.ts";
import { codexQuotaAdapter } from "./providers/codex.ts";
import { copilotQuotaAdapter } from "./providers/copilot.ts";
import type { QuotaCredentials, QuotaFetchOptions, QuotaProvider, QuotaProviderAdapter, QuotaProviderSetting, QuotaSnapshot } from "./types.ts";

export * from "./auth.ts";
export * from "./http.ts";
export * from "./types.ts";
export * from "./util.ts";
export { anthropicQuotaAdapter, fetchAnthropicUsage, parseAnthropicUsageResponse, resolveAnthropicUsageUrl } from "./providers/anthropic.ts";
export { codexQuotaAdapter, fetchCodexUsage, parseCodexUsageResponse, resolveCodexUsageUrl } from "./providers/codex.ts";
export { copilotQuotaAdapter, fetchCopilotUsage, parseCopilotUsageResponse } from "./providers/copilot.ts";

export const quotaAdapters: Record<QuotaProvider, QuotaProviderAdapter> = {
  codex: codexQuotaAdapter,
  anthropic: anthropicQuotaAdapter,
  copilot: copilotQuotaAdapter,
};

export function quotaProviderForModelProvider(modelProvider: string | undefined): QuotaProvider | null {
  switch (String(modelProvider ?? "").toLowerCase()) {
    case "openai-codex": return "codex";
    case "anthropic": return "anthropic";
    case "github-copilot": return "copilot";
    default: return null;
  }
}

export function detectQuotaProvider(modelProvider: string | undefined, configured: QuotaProviderSetting, usingOAuth = false): QuotaProvider | null {
  if (configured !== "auto") return configured === "off" ? null : configured;
  return usingOAuth ? quotaProviderForModelProvider(modelProvider) : null;
}

export function quotaCacheIdentity(provider: QuotaProvider, modelBaseUrl: string | undefined, credentials: QuotaCredentials | null | undefined): string {
  const identity = JSON.stringify([provider, modelBaseUrl?.trim() || "default", credentials?.accountId ?? "", credentials?.token ?? "no-auth"]);
  return `${provider}:${createHash("sha256").update(identity).digest("hex")}`;
}

export async function fetchQuotaForProvider(provider: QuotaProvider, options: QuotaFetchOptions = {}): Promise<QuotaSnapshot> {
  return quotaAdapters[provider].fetchUsage(options);
}
