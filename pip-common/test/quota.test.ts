import { describe, expect, it } from "vitest";
import {
  detectQuotaProvider,
  getCodexCredentials,
  getWindowLabel,
  parseAnthropicUsageResponse,
  parseCodexUsageResponse,
  parseCopilotUsageResponse,
} from "../src/quota/index.ts";

const now = Date.parse("2026-01-01T00:00:00Z");

describe("quota helpers", () => {
  it("detects quota providers from model providers", () => {
    expect(detectQuotaProvider("openai", "auto")).toBe("codex");
    expect(detectQuotaProvider("anthropic", "auto")).toBe("anthropic");
    expect(detectQuotaProvider("github-copilot", "auto")).toBe("copilot");
    expect(detectQuotaProvider("whatever", "codex")).toBe("codex");
    expect(detectQuotaProvider("openai", "off")).toBeNull();
  });

  it("gets codex credentials from pi auth first", () => {
    expect(getCodexCredentials({ auth: { "openai-codex": { access: "pi-token", accountId: "acct" } }, env: {} })).toEqual({ token: "pi-token", accountId: "acct" });
    expect(getCodexCredentials({ auth: {}, env: { OPENAI_API_KEY: "env-token" } })).toEqual({ token: "env-token" });
  });

  it("parses codex usage windows", () => {
    const windows = parseCodexUsageResponse(
      {
        rate_limit: {
          primary_window: { limit_window_seconds: 18_000, used_percent: 42, reset_at: now / 1000 + 3600 },
          secondary_window: { limit_window_seconds: 604_800, used_percent: 12, reset_at: now / 1000 + 86_400 },
        },
      },
      now
    );
    expect(windows.map((window) => window.label)).toEqual(["5h", "Week"]);
    expect(windows[0].usedPercent).toBe(42);
    expect(windows[0].resetsIn).toBe("1h");
  });

  it("parses anthropic and copilot usage windows", () => {
    expect(parseAnthropicUsageResponse({ five_hour: { utilization: 0.5 }, seven_day: { utilization: 25 } }, now).map((window) => window.usedPercent)).toEqual([50, 25]);
    expect(parseCopilotUsageResponse({ quota_reset_date_utc: new Date(now + 3600_000).toISOString(), quota_snapshots: { premium_interactions: { percent_remaining: 80 }, chat: { percent_remaining: 50 } } }, now).map((window) => window.usedPercent)).toEqual([20, 50]);
  });

  it("keeps unknown api shapes easy to inspect", () => {
    expect(parseCodexUsageResponse({ something_else: true }, now)).toEqual([]);
    expect(getWindowLabel(604_800_000, "fallback")).toBe("Week");
  });
});
