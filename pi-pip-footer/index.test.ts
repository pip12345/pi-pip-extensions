import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pipFooter, { __test } from "./index.ts";
import { createMockCtx, createMockPi, emitEvent } from "../pip-common/testing.ts";
import { getPipSettingsRegistry, registerFooterItem } from "../pip-common/index.ts";
import { USAGE_REFRESH_INTERVAL } from "./src/constants.ts";

const theme = { fg: (_name: string, text: string) => text };
const temporaryHomes: string[] = [];

function claudeCodeHome(token?: string): string {
  const home = mkdtempSync(join(tmpdir(), "claude-footer-"));
  temporaryHomes.push(home);
  const directory = join(home, ".claude");
  mkdirSync(directory);
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", directory);
  const path = join(directory, ".credentials.json");
  if (token) writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  const piAuth = join(home, ".pi", "agent");
  mkdirSync(piAuth, { recursive: true });
  writeFileSync(join(piAuth, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "other-pi-login" } }));
  return path;
}

function oauthRegistry(token: string, accountId?: string) {
  return {
    isUsingOAuth: () => true,
    getApiKeyForProvider: async () => token,
    authStorage: { get: () => ({ type: "oauth", access: token, accountId }) },
  };
}

function captureFooter(ctx: any) {
  ctx.ui.setFooter = (factory: any) => { ctx.ui.footerFactory = factory; };
  return () => ctx.ui.footerFactory?.({ requestRender() {} }, theme, {});
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("pi-pip-footer", () => {
  it("registers footer/token lifecycle handlers", () => {
    const pi = createMockPi();
    pipFooter(pi as any);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("agent_start")).toBe(true);
    expect(pi.handlers.has("message_end")).toBe(true);
    expect(pi.handlers.has("session_compact")).toBe(true);
    expect(pi.handlers.has("session_tree")).toBe(true);
    expect(pi.handlers.has("model_select")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);
  });

  it("detects only exact OAuth quota providers in auto mode", () => {
    expect(__test.detectProvider("openai-codex", "auto", true)).toBe("codex");
    expect(__test.detectProvider("anthropic", "auto", true)).toBe("anthropic");
    expect(__test.detectProvider("github-copilot", "auto", true)).toBe("copilot");
    expect(__test.detectProvider("openai", "auto", true)).toBeNull();
    expect(__test.detectProvider("openai-codex", "auto", false)).toBeNull();
    expect(__test.detectProvider("whatever", "codex")).toBe("codex");
    expect(__test.detectProvider("openai-codex", "off", true)).toBeNull();
  });

  it("shows a zero token baseline while first assistant response is pending", async () => {
    const pi = createMockPi();
    pipFooter(pi as any);
    const ctx = createMockCtx({ model: { contextWindow: 272_000 } });

    await emitEvent(pi, "session_start", {}, ctx);
    const factory = ctx.ui.widgets.get(__test.WIDGET_KEY);
    const component = factory({ requestRender() {} }, theme);
    expect(component.render(80)).toEqual(["↓:0 ↑:0 ↻:0 · $0"]);

    await emitEvent(pi, "turn_start", {}, ctx);
    expect(component.render(80)[0]).toMatch(/^↓:0 ↑:0 ↻:0 · \$0  [◐◓◑◒]$/);

    await emitEvent(pi, "session_shutdown", {}, ctx);
  });

  it("renders token-region metrics beside cache counts, not in the lower footer", async () => {
    const pi = createMockPi();
    pipFooter(pi as any);
    let metric = "15.0s · 60 t/s";
    registerFooterItem(pi, { id: "prompt-performance", region: "tokens", render: () => metric });
    const ctx = createMockCtx({ model: { contextWindow: 272_000 } });
    const getFooter = captureFooter(ctx);
    await emitEvent(pi, "session_start", {}, ctx);
    const component = ctx.ui.widgets.get(__test.WIDGET_KEY)({ requestRender() {} }, theme);
    const footer = getFooter();
    expect(component.render(120)).toEqual(["↓:0 ↑:0 ↻:0 · $0 · 15.0s · 60 t/s"]);
    expect(footer.render(120).join("\n")).not.toContain(metric);

    await emitEvent(pi, "agent_start", {}, ctx);
    await emitEvent(pi, "turn_start", {}, ctx);
    expect(component.render(120)[0]).toContain(metric);
    await emitEvent(pi, "message_update", { assistantMessageEvent: { type: "text_delta", delta: "Working" } }, ctx);
    expect(component.render(120)[0]).toContain(metric);
    expect(component.render(120)[0]).toContain("out");

    metric = "9.0s · 42 t/s";
    expect(component.render(120)[0]).toContain(metric);
    expect(component.render(120)[0]).not.toContain("15.0s");
    expect(component.render(16)[0].length).toBeLessThanOrEqual(16);
    await emitEvent(pi, "session_shutdown", {}, ctx);
  });

  it("can hide token counter cost", async () => {
    const pi = createMockPi();
    pipFooter(pi as any);
    getPipSettingsRegistry(pi).set("pi-pip-footer.showTokenCost", false);
    const ctx = createMockCtx({ model: { contextWindow: 272_000 } });

    await emitEvent(pi, "session_start", {}, ctx);
    const factory = ctx.ui.widgets.get(__test.WIDGET_KEY);
    const component = factory({ requestRender() {} }, theme);
    expect(component.render(80)).toEqual(["↓:0 ↑:0 ↻:0"]);
    await emitEvent(pi, "session_shutdown", {}, ctx);
  });

  it("renders settled live usage in the token widget", async () => {
    const pi = createMockPi();
    pipFooter(pi as any);
    const ctx = createMockCtx({ model: { contextWindow: 272_000 } });
    await emitEvent(pi, "session_start", {}, ctx);
    await emitEvent(pi, "message_end", { message: { role: "assistant", usage: { input: 1000, output: 2000, cacheRead: 3000, cost: { total: 0.04 } } } }, ctx);
    const factory = ctx.ui.widgets.get(__test.WIDGET_KEY);
    const component = factory({ requestRender() {} }, theme);
    expect(component.render(120)[0]).toContain("↓:1k ↑:2k ↻:3k/75% · $0.04");
    await emitEvent(pi, "session_shutdown", {}, ctx);
  });

  it("refreshes settled totals after persisted compaction usage", async () => {
    vi.useFakeTimers();
    const pi = createMockPi();
    pipFooter(pi as any);
    const entries: any[] = [
      { type: "message", id: "a1", message: { role: "assistant", provider: "openai", model: "gpt", usage: { input: 10, output: 2, cost: { total: 0.01 } } } },
    ];
    const ctx = createMockCtx({
      sessionManager: {
        getEntries: () => entries,
        getBranch: () => entries,
        getLeafId: () => entries.at(-1)?.id,
        getSessionFile: () => "/tmp/footer-compaction.jsonl",
      },
      model: { contextWindow: 272_000 },
    });
    await emitEvent(pi, "session_start", {}, ctx);
    const factory = ctx.ui.widgets.get(__test.WIDGET_KEY);
    const component = factory({ requestRender() {} }, theme);
    expect(component.render(120)[0]).toContain("↓:10 ↑:2");

    const compactionEntry = { type: "compaction", id: "c1", tokensBefore: 90_000, usage: { input: 20, output: 4, cost: { total: 0.02 } } };
    entries.push(compactionEntry);
    await emitEvent(pi, "session_compact", { compactionEntry }, ctx);
    component.render(120);
    vi.advanceTimersByTime(2000);
    expect(component.render(120)[0]).toContain("↓:30 ↑:6");
    expect(component.render(120)[0]).toContain("$0.03");
    await emitEvent(pi, "session_shutdown", {}, ctx);
    vi.useRealTimers();
  });

  it("can hide token counter cache hit rate", async () => {
    const pi = createMockPi();
    pipFooter(pi as any);
    getPipSettingsRegistry(pi).set("pi-pip-footer.showCacheHitRate", false);
    const ctx = createMockCtx({ model: { contextWindow: 272_000 } });
    await emitEvent(pi, "session_start", {}, ctx);
    await emitEvent(pi, "message_end", { message: { role: "assistant", usage: { input: 1000, output: 2000, cacheRead: 3000, cost: { total: 0.04 } } } }, ctx);
    const factory = ctx.ui.widgets.get(__test.WIDGET_KEY);
    const component = factory({ requestRender() {} }, theme);
    expect(component.render(120)[0]).toContain("↓:1k ↑:2k ↻:3k · $0.04");
    await emitEvent(pi, "session_shutdown", {}, ctx);
  });

  it("does no quota or timer work for headless or disabled sessions", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const model = { provider: "openai-codex", baseUrl: "https://quota.example", contextWindow: 272_000 };

    const headlessPi = createMockPi();
    pipFooter(headlessPi as any);
    const headless = createMockCtx({ hasUI: false, model });
    headless.modelRegistry = oauthRegistry("headless-token", "headless-account");
    await emitEvent(headlessPi, "session_start", {}, headless);
    await emitEvent(headlessPi, "model_select", {}, headless);

    const disabledPi = createMockPi();
    pipFooter(disabledPi as any);
    getPipSettingsRegistry(disabledPi).set("pi-pip-footer.enabled", false);
    const disabled = createMockCtx({ model });
    disabled.modelRegistry = oauthRegistry("disabled-token", "disabled-account");
    await emitEvent(disabledPi, "session_start", {}, disabled);
    await emitEvent(disabledPi, "model_select", {}, disabled);

    const apiKeyPi = createMockPi();
    pipFooter(apiKeyPi as any);
    const apiKeyCtx = createMockCtx({ model: { ...model, provider: "openai" } });
    apiKeyCtx.modelRegistry = { isUsingOAuth: () => false };
    await emitEvent(apiKeyPi, "session_start", {}, apiKeyCtx);

    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(headless.ui.widgets.size).toBe(0);
    expect(disabled.ui.widgets.size).toBe(0);
    await emitEvent(apiKeyPi, "session_shutdown", {}, apiKeyCtx);
  });

  it("clears switched quota state and rejects stale same-provider responses", async () => {
    const pending: Array<{ url: string; resolve(response: Response): void }> = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => new Promise<Response>((resolve) => pending.push({ url: String(input), resolve })));
    const pi = createMockPi();
    pipFooter(pi as any);
    const ctx = createMockCtx({ model: { id: "one", name: "One", provider: "openai-codex", baseUrl: "https://one.example", contextWindow: 272_000 } });
    ctx.modelRegistry = oauthRegistry("token-one", "account-one");
    const getFooter = captureFooter(ctx);

    await emitEvent(pi, "session_start", {}, ctx);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].resolve(new Response(JSON.stringify({ rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 41 } } }), { status: 200 }));
    const footer = getFooter();
    await vi.waitFor(() => expect(footer.render(120).join("\n")).toContain("41%"));

    ctx.model = { id: "two", name: "Two", provider: "openai-codex", baseUrl: "https://two.example", contextWindow: 272_000 };
    ctx.modelRegistry = oauthRegistry("token-two", "account-two");
    await emitEvent(pi, "model_select", {}, ctx);
    expect(footer.render(120).join("\n")).not.toContain("41%");
    await vi.waitFor(() => expect(pending).toHaveLength(2));

    ctx.model = { id: "three", name: "Three", provider: "openai-codex", baseUrl: "https://three.example", contextWindow: 272_000 };
    ctx.modelRegistry = oauthRegistry("token-three", "account-three");
    await emitEvent(pi, "model_select", {}, ctx);
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    pending[2].resolve(new Response(JSON.stringify({ rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 73 } } }), { status: 200 }));
    await vi.waitFor(() => expect(footer.render(120).join("\n")).toContain("73%"));
    pending[1].resolve(new Response(JSON.stringify({ rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 52 } } }), { status: 200 }));
    await Promise.resolve();
    expect(footer.render(120).join("\n")).toContain("73%");
    expect(footer.render(120).join("\n")).not.toContain("52%");
    expect(pending.map((request) => request.url)).toEqual([
      "https://one.example/wham/usage",
      "https://two.example/wham/usage",
      "https://three.example/wham/usage",
    ]);
    await emitEvent(pi, "session_shutdown", {}, ctx);
  });

  it.each(["auto", "anthropic"])("shows Claude Agent quota with Claude Code credentials in %s mode", async (configured) => {
    claudeCodeHome("native-token");
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      five_hour: { utilization: 37 }, seven_day: { utilization: 12 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const pi = createMockPi();
    pipFooter(pi as any);
    getPipSettingsRegistry(pi).set("pi-pip-footer.quotaProvider", configured);
    const ctx = createMockCtx({ model: { provider: "claude-agent", baseUrl: "https://api.anthropic.com", contextWindow: 200_000 } });
    const getApiKey = vi.fn();
    ctx.modelRegistry = { isUsingOAuth: () => false, getApiKeyForProvider: getApiKey };
    const getFooter = captureFooter(ctx);

    await emitEvent(pi, "session_start", {}, ctx);
    await vi.waitFor(() => expect(getFooter().render(120).join("\n")).toContain("37%"));
    expect(getFooter().render(120).join("\n")).toContain("12%");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer native-token");
    expect(getApiKey).not.toHaveBeenCalled();
    await emitEvent(pi, "session_shutdown", {}, ctx);
  });

  it("rereads Claude Code tokens on quota refresh and clears quota after logout", async () => {
    vi.useFakeTimers();
    const path = claudeCodeHome("first-native-token");
    const tokens: Array<string | null> = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      tokens.push(new Headers(init?.headers).get("Authorization"));
      return new Response(JSON.stringify({ five_hour: { utilization: tokens.length === 1 ? 37 : 48 } }), { status: 200 });
    });
    const pi = createMockPi();
    pipFooter(pi as any);
    const ctx = createMockCtx({ model: { provider: "claude-agent", contextWindow: 200_000 } });
    ctx.modelRegistry = { isUsingOAuth: () => false };
    const getFooter = captureFooter(ctx);
    await emitEvent(pi, "session_start", {}, ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(getFooter().render(120).join("\n")).toContain("37%");

    writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: "second-native-token" } }));
    await vi.advanceTimersByTimeAsync(USAGE_REFRESH_INTERVAL);
    expect(tokens).toEqual(["Bearer first-native-token", "Bearer second-native-token"]);
    expect(getFooter().render(120).join("\n")).toContain("48%");
    expect(getFooter().render(120).join("\n")).not.toContain("37%");

    unlinkSync(path);
    await vi.advanceTimersByTimeAsync(USAGE_REFRESH_INTERVAL);
    expect(tokens).toHaveLength(2);
    expect(getFooter().render(120).join("\n")).not.toContain("48%");
    expect(getFooter().render(120).join("\n")).toContain("usage offline");
    await emitEvent(pi, "session_shutdown", {}, ctx);
  });

  it.each([undefined, "invalid json", JSON.stringify({ apiKey: "native-api-key" })])(
    "does not use another Pi login when Claude Code OAuth is unavailable: %s",
    async (contents) => {
      const path = claudeCodeHome();
      if (contents) writeFileSync(path, contents);
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const pi = createMockPi();
      pipFooter(pi as any);
      const ctx = createMockCtx({ model: { provider: "claude-agent", contextWindow: 200_000 } });
      ctx.modelRegistry = oauthRegistry("unrelated-pi-token");
      const getFooter = captureFooter(ctx);
      await emitEvent(pi, "session_start", {}, ctx);
      await vi.waitFor(() => expect(getFooter().render(120).join("\n")).toContain("usage offline"));
      expect(fetchSpy).not.toHaveBeenCalled();
      await emitEvent(pi, "session_shutdown", {}, ctx);
    },
  );

  it("skips Claude Agent quota when headless, disabled, or quota is off", async () => {
    claudeCodeHome("native-token");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const mode of ["headless", "disabled", "off"]) {
      const pi = createMockPi();
      pipFooter(pi as any);
      if (mode === "disabled") getPipSettingsRegistry(pi).set("pi-pip-footer.enabled", false);
      if (mode === "off") getPipSettingsRegistry(pi).set("pi-pip-footer.quotaProvider", "off");
      const ctx = createMockCtx({ hasUI: mode !== "headless", model: { provider: "claude-agent", contextWindow: 200_000 } });
      ctx.modelRegistry = { isUsingOAuth: () => false };
      await emitEvent(pi, "session_start", {}, ctx);
      await emitEvent(pi, "model_select", {}, ctx);
      await emitEvent(pi, "session_shutdown", {}, ctx);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the active OAuth model baseUrl for quota checks", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 42 } } }), { status: 200 });
    });
    const pi = createMockPi();
    pipFooter(pi as any);
    const ctx = createMockCtx({ model: { provider: "openai-codex", baseUrl: "http://172.17.0.1:9898/chatgpt/backend-api", contextWindow: 272_000 } });
    ctx.modelRegistry = oauthRegistry("token", "acct");

    await emitEvent(pi, "session_start", {}, ctx);
    await vi.waitFor(() => expect(urls).toContain("http://172.17.0.1:9898/chatgpt/backend-api/wham/usage"));
    await emitEvent(pi, "session_shutdown", {}, ctx);
  });
});
