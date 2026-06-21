import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  it("saves and loads normalized config", () => {
    const path = tempConfigPath();
    saveProviderProxyConfig({ enabled: true, providers: { openai: " http://127.0.0.1:9000/openai/v1 " }, auth: {} }, path);
    expect(loadProviderProxyConfig(path)).toEqual({ enabled: true, providers: { openai: "http://127.0.0.1:9000/openai/v1" }, auth: {} });
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

  it("sets status on session_start when providers are active", async () => {
    const path = tempConfigPath();
    saveProviderProxyConfig({ enabled: true, providers: { openai: "http://127.0.0.1:9000/openai/v1" }, auth: { anthropic: "http://127.0.0.1:9000/anthropic-auth" } }, path);
    const pi = createProviderPi();
    registerProviderProxyExtension(pi, { configPath: path });
    const ctx = createMockCtx();

    await emitEvent(pi, "session_start", {}, ctx);

    expect(ctx.ui.statuses.get("provider-proxy")).toBe("proxy:2");
  });
});
