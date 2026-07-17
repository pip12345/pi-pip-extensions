import { afterEach, describe, expect, it, vi } from "vitest";
import pipFooter, { __test } from "./index.ts";
import { createMockCtx, createMockPi, emitEvent } from "../pip-common/testing.ts";
import { getPipSettingsRegistry } from "../pip-common/index.ts";

const theme = { fg: (_name: string, text: string) => text };

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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("pi-pip-footer", () => {
  it("registers footer/token lifecycle handlers", () => {
    const pi = createMockPi();
    pipFooter(pi as any);
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("agent_start")).toBe(true);
    expect(pi.handlers.has("message_end")).toBe(true);
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
    expect(component.render(120)[0]).toContain("↓:4k ↑:2k ↻:3k/75% · $0.04");
    await emitEvent(pi, "session_shutdown", {}, ctx);
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
    expect(component.render(120)[0]).toContain("↓:4k ↑:2k ↻:3k · $0.04");
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
