import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockCtx, createMockPi, emitEvent, runCommand } from "../pip-common/testing.ts";
import {
  applyProviderProxyConfig,
  createRelayedOAuthProvider,
  loadProviderProxyConfig,
  normalizeBaseUrl,
  normalizeProviderProxyConfig,
  providerAuthRouteHelp,
  providerProxyStatus,
  providerRegistrationConfig,
  providerRouteHelp,
  recommendedProviderAuthUrl,
  recommendedProviderBaseUrl,
  registerProviderProxyExtension,
  saveProviderProxyConfig,
  SSH_TUNNEL_HINT,
} from "./index.ts";

const tempDirs: string[] = [];

function tempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-provider-proxy-"));
  tempDirs.push(dir);
  return join(dir, "provider-proxy.json");
}

function createProviderPi() {
  const pi = createMockPi() as any;
  pi.providerOverrides = new Map<string, any>();
  pi.unregisteredProviders = [] as string[];
  pi.registerProvider = (provider: string, config: any) => pi.providerOverrides.set(provider, config);
  pi.unregisterProvider = (provider: string) => {
    pi.unregisteredProviders.push(provider);
    pi.providerOverrides.delete(provider);
  };
  return pi;
}

function fakeOpenAIToken(accountId = "acct_test"): string {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  return `header.${payload}.signature`;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("provider proxy config", () => {
  it("normalizes provider and auth relay maps", () => {
    expect(
      normalizeProviderProxyConfig({
        providers: {
          openai: "http://127.0.0.1:9000/openai/v1",
          "openai-codex": { baseUrl: "http://127.0.0.1:9000/chatgpt/backend-api" },
        },
        auth: {
          "openai-codex": "http://127.0.0.1:9000/openai-auth",
          anthropic: { baseUrl: "http://127.0.0.1:9000/anthropic-auth" },
        },
      }),
    ).toEqual({
      enabled: false,
      providers: {
        openai: "http://127.0.0.1:9000/openai/v1",
        "openai-codex": "http://127.0.0.1:9000/chatgpt/backend-api",
      },
      auth: {
        "openai-codex": "http://127.0.0.1:9000/openai-auth",
        anthropic: "http://127.0.0.1:9000/anthropic-auth",
      },
    });
  });

  it("rejects invalid baseUrl protocols", () => {
    expect(() => normalizeBaseUrl("socks5://127.0.0.1:1080")).toThrow(/http:\/\/ or https:\/\//);
  });

  it("recommends explicit provider API and auth relay URLs", () => {
    expect(recommendedProviderBaseUrl("openai")).toBe("http://127.0.0.1:9898/openai/v1");
    expect(recommendedProviderBaseUrl("openai-codex")).toBe("http://127.0.0.1:9898/chatgpt/backend-api");
    expect(recommendedProviderAuthUrl("openai-codex")).toBe("http://127.0.0.1:9898/openai-auth");
    expect(recommendedProviderAuthUrl("anthropic", "http://172.17.0.1:9898")).toBe("http://172.17.0.1:9898/anthropic-auth");
    expect(providerRouteHelp()).toContain("openai-codex  <relay>/chatgpt/backend-api");
    expect(providerAuthRouteHelp()).toContain("openai-codex  <relay>/openai-auth");
  });

  it("atomically saves and loads normalized private config", () => {
    const path = tempConfigPath();
    saveProviderProxyConfig({ enabled: true, providers: { openai: " http://127.0.0.1:9000/openai/v1 " }, auth: {} }, path);
    expect(loadProviderProxyConfig(path)).toEqual({ enabled: true, providers: { openai: "http://127.0.0.1:9000/openai/v1" }, auth: {} });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(path, ".."))).toEqual(["provider-proxy.json"]);
  });

  it("formats status with API and auth maps plus SSH hint", () => {
    const text = providerProxyStatus(
      {
        enabled: true,
        providers: { openai: "http://127.0.0.1:9000/openai/v1" },
        auth: { "openai-codex": "http://127.0.0.1:9000/openai-auth" },
      },
      "/tmp/provider-proxy.json",
    );
    expect(text).toContain("openai -> http://127.0.0.1:9000/openai/v1");
    expect(text).toContain("openai-codex -> http://127.0.0.1:9000/openai-auth");
    expect(text).toContain(SSH_TUNNEL_HINT);
  });
});

describe("provider proxy registration", () => {
  it("applies enabled API config at startup", () => {
    const pi = createProviderPi();
    const applied = applyProviderProxyConfig(pi, { enabled: true, providers: { openai: "http://127.0.0.1:9000/openai/v1" }, auth: {} });
    expect(applied).toEqual(["openai"]);
    expect(pi.providerOverrides.get("openai")).toEqual({ baseUrl: "http://127.0.0.1:9000/openai/v1" });
  });

  it("combines API baseUrl and auth relay registration for one provider", () => {
    const registration = providerRegistrationConfig("openai-codex", {
      enabled: true,
      providers: { "openai-codex": "http://127.0.0.1:9000/chatgpt/backend-api" },
      auth: { "openai-codex": "http://127.0.0.1:9000/openai-auth" },
    });
    expect(registration?.baseUrl).toBe("http://127.0.0.1:9000/chatgpt/backend-api");
    expect(registration?.oauth).toEqual(expect.objectContaining({ name: "ChatGPT Plus/Pro (Codex Subscription)", usesCallbackServer: true }));
  });

  it("creates an OpenAI Codex OAuth provider that refreshes through the auth relay", async () => {
    const calls: Array<{ input: string; body: string }> = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      calls.push({ input, body: String(init.body) });
      return new Response(JSON.stringify({ access_token: fakeOpenAIToken("acct_123"), refresh_token: "refresh_2", expires_in: 3600 }), { status: 200 });
    });

    const oauth = createRelayedOAuthProvider("openai-codex", "http://127.0.0.1:9000/openai-auth");
    const creds = await oauth.refreshToken({ access: "old", refresh: "refresh_1", expires: 0 });

    expect(calls[0].input).toBe("http://127.0.0.1:9000/openai-auth/oauth/token");
    expect(calls[0].body).toContain("grant_type=refresh_token");
    expect(creds.refresh).toBe("refresh_2");
    expect(creds.accountId).toBe("acct_123");
  });

  it("creates an Anthropic OAuth provider that refreshes through the auth relay", async () => {
    const calls: Array<{ input: string; body: any }> = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      calls.push({ input, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ access_token: "access_2", refresh_token: "refresh_2", expires_in: 3600 }), { status: 200 });
    });

    const oauth = createRelayedOAuthProvider("anthropic", "http://127.0.0.1:9000/anthropic-auth");
    const creds = await oauth.refreshToken({ access: "old", refresh: "refresh_1", expires: 0 });

    expect(calls[0].input).toBe("http://127.0.0.1:9000/anthropic-auth/v1/oauth/token");
    expect(calls[0].body).toMatchObject({ grant_type: "refresh_token" });
    expect(creds.access).toBe("access_2");
  });

  it("omits OAuth response secrets from validation and HTTP errors", async () => {
    const oauth = createRelayedOAuthProvider("anthropic", "http://user:password@127.0.0.1:9000/anthropic-auth?secret=query");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ access_token: "secret-access", unexpected: true }), { status: 200 }));
    await expect(oauth.refreshToken({ access: "old", refresh: "refresh_1", expires: 0 })).rejects.not.toThrow(/secret-access/);

    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ refresh_token: "secret-refresh" }), { status: 400 }));
    const error = await oauth.refreshToken({ access: "old", refresh: "refresh_1", expires: 0 }).catch((caught) => caught as Error);
    expect(error.message).toContain("response body omitted");
    expect(error.message).not.toMatch(/secret-refresh|password|secret=query/);

    vi.stubGlobal("fetch", async () => new Response("secret-access is not json", { status: 200 }));
    const parseError = await oauth.refreshToken({ access: "old", refresh: "refresh_1", expires: 0 }).catch((caught) => caught as Error);
    expect(parseError.message).toContain("response body omitted");
    expect(parseError.message).not.toContain("secret-access");
  });

  it("bounds OAuth relay response bodies and refresh deadlines", async () => {
    const oauth = createRelayedOAuthProvider("anthropic", "http://127.0.0.1:9000/anthropic-auth");
    vi.stubGlobal("fetch", async () => new Response("ignored", { status: 200, headers: { "content-length": String(300 * 1024) } }));
    await expect(oauth.refreshToken({ access: "old", refresh: "refresh_1", expires: 0 })).rejects.toThrow(/response exceeded .* byte limit/);

    vi.useFakeTimers();
    vi.stubGlobal("fetch", async (_input: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const refresh = oauth.refreshToken({ access: "old", refresh: "refresh_1", expires: 0 });
    const assertion = expect(refresh).rejects.toThrow(/request timed out/);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it("settles a browser callback that reports an OAuth error", async () => {
    const oauth = createRelayedOAuthProvider("openai-codex", "http://127.0.0.1:9000/openai-auth");
    await expect(
      oauth.login({
        onSelect: async () => "browser",
        onAuth: () => {
          void fetch("http://127.0.0.1:1455/auth/callback?error=secret-provider-detail");
        },
        onPrompt: async () => {
          throw new Error("prompt should not run after callback error");
        },
      } as any),
    ).rejects.toThrow("OAuth callback reported an error");
  });

  it("cancels a browser callback wait through the login signal", async () => {
    const oauth = createRelayedOAuthProvider("openai-codex", "http://127.0.0.1:9000/openai-auth");
    const controller = new AbortController();
    await expect(
      oauth.login({
        onSelect: async () => "browser",
        onAuth: () => controller.abort(),
        onPrompt: async () => {
          throw new Error("prompt should not run after cancellation");
        },
        signal: controller.signal,
      } as any),
    ).rejects.toThrow("Login cancelled");
  });
});

describe("provider proxy extension", () => {
  it("registers /proxy and adds provider API overrides from args", async () => {
    const path = tempConfigPath();
    const pi = createProviderPi();
    registerProviderProxyExtension(pi, { configPath: path });

    await runCommand(pi, "proxy", "add openai http://127.0.0.1:9000/openai/v1", createMockCtx());

    expect(pi.providerOverrides.get("openai")).toEqual({ baseUrl: "http://127.0.0.1:9000/openai/v1" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ enabled: true, providers: { openai: "http://127.0.0.1:9000/openai/v1" }, auth: {} });
  });

  it("registers /proxy auth and preserves the explicit auth relay URL", async () => {
    const path = tempConfigPath();
    const pi = createProviderPi();
    registerProviderProxyExtension(pi, { configPath: path });

    await runCommand(pi, "proxy", "auth add openai-codex http://172.17.0.1:9898/openai-auth", createMockCtx());

    expect(pi.providerOverrides.get("openai-codex").oauth).toEqual(expect.objectContaining({ name: "ChatGPT Plus/Pro (Codex Subscription)" }));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      enabled: true,
      providers: {},
      auth: { "openai-codex": "http://172.17.0.1:9898/openai-auth" },
    });
  });

  it("reapplies a provider when API and auth maps are updated independently", async () => {
    const path = tempConfigPath();
    const pi = createProviderPi();
    registerProviderProxyExtension(pi, { configPath: path });

    await runCommand(pi, "proxy", "auth add openai-codex http://172.17.0.1:9898/openai-auth", createMockCtx());
    await runCommand(pi, "proxy", "add openai-codex http://172.17.0.1:9898/chatgpt/backend-api", createMockCtx());

    expect(pi.unregisteredProviders).toContain("openai-codex");
    expect(pi.providerOverrides.get("openai-codex")).toEqual(
      expect.objectContaining({
        baseUrl: "http://172.17.0.1:9898/chatgpt/backend-api",
        oauth: expect.objectContaining({ name: "ChatGPT Plus/Pro (Codex Subscription)" }),
      }),
    );
  });

  it("disables overrides and unregisters applied providers", async () => {
    const path = tempConfigPath();
    saveProviderProxyConfig({ enabled: true, providers: { openai: "http://127.0.0.1:9000/openai/v1" }, auth: {} }, path);
    const pi = createProviderPi();
    registerProviderProxyExtension(pi, { configPath: path });

    await runCommand(pi, "proxy", "off", createMockCtx());

    expect(pi.unregisteredProviders).toEqual(["openai"]);
    expect(loadProviderProxyConfig(path).enabled).toBe(false);
  });

  it("reconciles providers removed by an external config edit", async () => {
    const path = tempConfigPath();
    saveProviderProxyConfig({ enabled: true, providers: { openai: "http://127.0.0.1:9000/openai/v1" }, auth: {} }, path);
    const pi = createProviderPi();
    registerProviderProxyExtension(pi, { configPath: path });
    saveProviderProxyConfig({ enabled: true, providers: {}, auth: {} }, path);

    await runCommand(pi, "proxy", "status", createMockCtx());

    expect(pi.providerOverrides.has("openai")).toBe(false);
    expect(pi.unregisteredProviders).toEqual(["openai"]);
  });

  it("preserves the last valid routes when an external config cannot be applied", async () => {
    const path = tempConfigPath();
    saveProviderProxyConfig({ enabled: true, providers: { openai: "http://127.0.0.1:9000/openai/v1" }, auth: {} }, path);
    const pi = createProviderPi();
    registerProviderProxyExtension(pi, { configPath: path });
    saveProviderProxyConfig({ enabled: true, providers: {}, auth: { unsupported: "http://127.0.0.1:9000/auth" } }, path);
    const ctx = createMockCtx();

    await runCommand(pi, "proxy", "status", ctx);

    expect(pi.providerOverrides.get("openai")).toEqual({ baseUrl: "http://127.0.0.1:9000/openai/v1" });
    expect(pi.unregisteredProviders).toEqual([]);
    expect(ctx.ui.notifications.at(-1).message).toContain("No auth relay support for unsupported");
  });

  it("keeps runtime and disk config unchanged when a command cannot register its replacement", async () => {
    const path = tempConfigPath();
    const oldUrl = "http://127.0.0.1:9000/openai/v1";
    saveProviderProxyConfig({ enabled: true, providers: { openai: oldUrl }, auth: {} }, path);
    const pi = createProviderPi();
    registerProviderProxyExtension(pi, { configPath: path });
    const register = pi.registerProvider;
    let rejectNext = true;
    pi.registerProvider = (provider: string, config: any) => {
      if (rejectNext && config.baseUrl === "http://127.0.0.1:9001/openai/v1") {
        rejectNext = false;
        throw new Error("replacement rejected");
      }
      return register(provider, config);
    };
    const ctx = createMockCtx();

    await runCommand(pi, "proxy", "add openai http://127.0.0.1:9001/openai/v1", ctx);

    expect(ctx.ui.notifications.at(-1).message).toContain("replacement rejected");
    expect(pi.providerOverrides.get("openai")).toEqual({ baseUrl: oldUrl });
    expect(loadProviderProxyConfig(path)).toEqual({ enabled: true, providers: { openai: oldUrl }, auth: {} });
  });

  it("unregisters owned providers during shutdown", async () => {
    const path = tempConfigPath();
    saveProviderProxyConfig({ enabled: true, providers: { openai: "http://127.0.0.1:9000/openai/v1" }, auth: {} }, path);
    const pi = createProviderPi();
    registerProviderProxyExtension(pi, { configPath: path });

    await emitEvent(pi, "session_shutdown", {});

    expect(pi.providerOverrides.has("openai")).toBe(false);
    expect(pi.unregisteredProviders).toEqual(["openai"]);
  });

  it("shows bare /proxy help and status", async () => {
    const path = tempConfigPath();
    const pi = createProviderPi();
    registerProviderProxyExtension(pi, { configPath: path });
    const ctx = createMockCtx();

    await runCommand(pi, "proxy", "", ctx);

    expect(ctx.ui.notifications.at(-1).message).toContain("Provider proxy: disabled");
    expect(ctx.ui.notifications.at(-1).message).toContain("/proxy add <provider> <url>");
    expect(ctx.ui.notifications.at(-1).message).toContain("/proxy auth add <provider> <url>");
    expect(ctx.ui.notifications.at(-1).message).toContain("Pi in Docker, tunnel on host:   http://172.17.0.1:9898");
    expect(ctx.ui.notifications.at(-1).message).toContain("openai-codex  <relay>/chatgpt/backend-api");
    expect(ctx.ui.notifications.at(-1).message).toContain("openai-codex  <relay>/openai-auth");
    expect(ctx.ui.notifications.at(-1).message).toContain(SSH_TUNNEL_HINT);
  });

  it("shows a simple on/off status badge", async () => {
    const path = tempConfigPath();
    saveProviderProxyConfig({ enabled: true, providers: { openai: "http://127.0.0.1:9000/openai/v1" }, auth: { anthropic: "http://127.0.0.1:9000/anthropic-auth" } }, path);
    const pi = createProviderPi();
    registerProviderProxyExtension(pi, { configPath: path });
    const ctx = createMockCtx();

    await emitEvent(pi, "session_start", {}, ctx);
    expect(ctx.ui.statuses.get("provider-proxy")).toBe("proxy: on");

    await runCommand(pi, "proxy", "off", ctx);
    expect(ctx.ui.statuses.get("provider-proxy")).toBeUndefined();
  });
});
