import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockCtx, createMockPi, emitEvent, runCommand } from "../pip-common/testing.ts";
import {
  applyProviderProxyConfig,
  loadProviderProxyConfig,
  normalizeBaseUrl,
  normalizeProviderProxyConfig,
  providerProxyStatus,
  providerRouteHelp,
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("provider proxy config", () => {
  it("normalizes simple provider to baseUrl maps", () => {
    expect(
      normalizeProviderProxyConfig({
        providers: {
          openai: "http://127.0.0.1:9000/openai/v1",
          "openai-codex": { baseUrl: "http://127.0.0.1:9000/chatgpt/backend-api" },
        },
      }),
    ).toEqual({
      enabled: false,
      providers: {
        openai: "http://127.0.0.1:9000/openai/v1",
        "openai-codex": "http://127.0.0.1:9000/chatgpt/backend-api",
      },
    });
  });

  it("rejects invalid baseUrl protocols", () => {
    expect(() => normalizeBaseUrl("socks5://127.0.0.1:1080")).toThrow(/http:\/\/ or https:\/\//);
  });

  it("recommends explicit provider relay URLs", () => {
    expect(recommendedProviderBaseUrl("openai")).toBe("http://127.0.0.1:9898/openai/v1");
    expect(recommendedProviderBaseUrl("openai-codex")).toBe("http://127.0.0.1:9898/chatgpt/backend-api");
    expect(providerRouteHelp()).toContain("openai-codex  <relay>/chatgpt/backend-api");
    expect(providerRouteHelp("http://172.17.0.1:9898")).toContain("openai-codex  http://172.17.0.1:9898/chatgpt/backend-api");
  });

  it("saves and loads normalized config", () => {
    const path = tempConfigPath();
    saveProviderProxyConfig({ enabled: true, providers: { openai: " http://127.0.0.1:9000/openai/v1 " } }, path);
    expect(loadProviderProxyConfig(path)).toEqual({ enabled: true, providers: { openai: "http://127.0.0.1:9000/openai/v1" } });
  });

  it("formats status with SSH hint", () => {
    const text = providerProxyStatus({ enabled: true, providers: { openai: "http://127.0.0.1:9000/openai/v1" } }, "/tmp/provider-proxy.json");
    expect(text).toContain("openai -> http://127.0.0.1:9000/openai/v1");
    expect(text).toContain(SSH_TUNNEL_HINT);
  });
});

describe("provider proxy extension", () => {
  it("applies enabled config at startup", () => {
    const pi = createProviderPi();
    const applied = applyProviderProxyConfig(pi, { enabled: true, providers: { openai: "http://127.0.0.1:9000/openai/v1" } });
    expect(applied).toEqual(["openai"]);
    expect(pi.providerOverrides.get("openai")).toEqual({ baseUrl: "http://127.0.0.1:9000/openai/v1" });
  });

  it("registers /proxy and adds provider overrides from args", async () => {
    const path = tempConfigPath();
    const pi = createProviderPi();
    registerProviderProxyExtension(pi, { configPath: path });

    await runCommand(pi, "proxy", "add openai http://127.0.0.1:9000/openai/v1", createMockCtx());

    expect(pi.providerOverrides.get("openai")).toEqual({ baseUrl: "http://127.0.0.1:9000/openai/v1" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ enabled: true, providers: { openai: "http://127.0.0.1:9000/openai/v1" } });
  });

  it("registers openai-codex exactly as configured", async () => {
    const path = tempConfigPath();
    const pi = createProviderPi();
    registerProviderProxyExtension(pi, { configPath: path });

    await runCommand(pi, "proxy", "add openai-codex http://172.17.0.1:9898/chatgpt/backend-api", createMockCtx());

    expect(pi.providerOverrides.get("openai-codex")).toEqual({ baseUrl: "http://172.17.0.1:9898/chatgpt/backend-api" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      enabled: true,
      providers: { "openai-codex": "http://172.17.0.1:9898/chatgpt/backend-api" },
    });
  });

  it("disables overrides and unregisters applied providers", async () => {
    const path = tempConfigPath();
    saveProviderProxyConfig({ enabled: true, providers: { openai: "http://127.0.0.1:9000/openai/v1" } }, path);
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
    expect(ctx.ui.notifications.at(-1).message).toContain("Pi in Docker, tunnel on host:   http://172.17.0.1:9898");
    expect(ctx.ui.notifications.at(-1).message).toContain("openai-codex  <relay>/chatgpt/backend-api");
    expect(ctx.ui.notifications.at(-1).message).toContain(SSH_TUNNEL_HINT);
  });

  it("sets status on session_start when providers are active", async () => {
    const path = tempConfigPath();
    saveProviderProxyConfig({ enabled: true, providers: { openai: "http://127.0.0.1:9000/openai/v1" } }, path);
    const pi = createProviderPi();
    registerProviderProxyExtension(pi, { configPath: path });
    const ctx = createMockCtx();

    await emitEvent(pi, "session_start", {}, ctx);

    expect(ctx.ui.statuses.get("provider-proxy")).toBe("proxy:1");
  });
});
