import { anthropicQuotaAdapter, fetchAnthropicUsage, parseAnthropicUsageResponse } from "./providers/anthropic.ts";
import { codexQuotaAdapter, fetchCodexUsage, parseCodexUsageResponse } from "./providers/codex.ts";
import { copilotQuotaAdapter, fetchCopilotUsage, parseCopilotUsageResponse } from "./providers/copilot.ts";
import type { QuotaFetchOptions, QuotaProvider, QuotaProviderAdapter, QuotaProviderSetting, QuotaSnapshot } from "./types.ts";

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

export function detectQuotaProvider(modelProvider: string | undefined, configured: QuotaProviderSetting): QuotaProvider | null {
  if (configured !== "auto") return configured === "off" ? null : configured;
  const provider = String(modelProvider ?? "").toLowerCase();
  if (provider.includes("codex") || provider === "openai" || provider === "openai-completions") return "codex";
  if (provider.includes("anthropic") || provider.includes("claude")) return "anthropic";
  if (provider.includes("copilot") || provider.includes("github")) return "copilot";
  return null;
}

export async function fetchQuotaForProvider(provider: QuotaProvider, options: QuotaFetchOptions = {}): Promise<QuotaSnapshot> {
  return quotaAdapters[provider].fetchUsage(options);
}
