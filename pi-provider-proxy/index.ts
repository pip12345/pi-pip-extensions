import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { pipPath } from "../pip-common/index.ts";

export interface ProviderProxyConfig {
  enabled: boolean;
  providers: Record<string, string>;
}

export interface ProviderProxyOptions {
  configPath?: string;
}

export interface ProviderRouteHint {
  provider: string;
  path: string;
  note?: string;
}

export const CONFIG_PATH = pipPath("provider-proxy.json");
export const DEFAULT_CONFIG: ProviderProxyConfig = { enabled: false, providers: {} };
export const SSH_TUNNEL_HINT = "ssh -N -L 127.0.0.1:9898:127.0.0.1:9898 user@server";
export const DEFAULT_RELAY_BASE_URL = "http://127.0.0.1:9898";
export const DOCKER_HOST_RELAY_BASE_URL = "http://172.17.0.1:9898";
export const PROVIDER_ROUTE_HINTS: ProviderRouteHint[] = [
  { provider: "openai", path: "/openai/v1" },
  { provider: "openai-codex", path: "/chatgpt/backend-api" },
  { provider: "anthropic", path: "/anthropic" },
];

const COMMANDS = `Commands:
  /proxy                         Show status, commands, and SSH tunnel hint
  /proxy status                  Show current provider overrides
  /proxy setup                   Add or update one or more provider baseUrls interactively
  /proxy add <provider> <url>    Add or update one provider override
  /proxy remove <provider>       Remove one provider override
  /proxy on                      Enable configured overrides
  /proxy off                     Disable configured overrides and restore providers

Relay base examples:
  native Pi / same namespace:     ${DEFAULT_RELAY_BASE_URL}
  Pi in Docker, tunnel on host:   ${DOCKER_HOST_RELAY_BASE_URL}

${providerRouteHelp()}

Relay route contract:
  /openai/*     -> https://api.openai.com/*
  /chatgpt/*    -> https://chatgpt.com/*
  /anthropic/*  -> https://api.anthropic.com/*

External SSH tunnel hint:
  ${SSH_TUNNEL_HINT}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function displayPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function normalizeProviderId(provider: string): string {
  const value = provider.trim();
  if (!value || /[\s\0]/.test(value)) throw new Error(`Invalid provider id: ${JSON.stringify(provider)}`);
  return value;
}

export function normalizeBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid baseUrl: ${JSON.stringify(baseUrl)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid baseUrl protocol for ${value}; use http:// or https://`);
  }
  return value;
}

function joinUrlPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function recommendedProviderBaseUrl(provider: string, relayBaseUrl = DEFAULT_RELAY_BASE_URL): string {
  const normalizedProvider = normalizeProviderId(provider);
  const hint = PROVIDER_ROUTE_HINTS.find((entry) => entry.provider === normalizedProvider);
  return joinUrlPath(normalizeBaseUrl(relayBaseUrl), hint?.path ?? `/${normalizedProvider}`);
}

export function providerRouteHelp(relayBaseUrl = "<relay>"): string {
  const providerWidth = Math.max(...PROVIDER_ROUTE_HINTS.map((entry) => entry.provider.length));
  const lines = ["Provider baseUrls to configure:"];
  for (const entry of PROVIDER_ROUTE_HINTS) {
    const provider = entry.provider.padEnd(providerWidth);
    const url = relayBaseUrl === "<relay>" ? joinUrlPath(relayBaseUrl, entry.path) : recommendedProviderBaseUrl(entry.provider, relayBaseUrl);
    lines.push(`  ${provider}  ${url}${entry.note ? `  (${entry.note})` : ""}`);
  }
  return lines.join("\n");
}

export function normalizeProviderProxyConfig(raw: unknown): ProviderProxyConfig {
  if (!isRecord(raw)) return { ...DEFAULT_CONFIG, providers: {} };
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled;
  const providersRaw = isRecord(raw.providers) ? raw.providers : {};
  const providers: Record<string, string> = {};

  for (const [providerKey, entry] of Object.entries(providersRaw)) {
    const provider = normalizeProviderId(providerKey);
    const baseUrl = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.baseUrl === "string" ? entry.baseUrl : undefined;
    if (baseUrl === undefined) throw new Error(`Invalid provider proxy entry for ${provider}; expected a baseUrl string`);
    providers[provider] = normalizeBaseUrl(baseUrl);
  }

  return { enabled, providers };
}

export function loadProviderProxyConfig(path = CONFIG_PATH): ProviderProxyConfig {
  if (!existsSync(path)) return { ...DEFAULT_CONFIG, providers: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return normalizeProviderProxyConfig(parsed);
}

export function saveProviderProxyConfig(config: ProviderProxyConfig, path = CONFIG_PATH): void {
  const normalized = normalizeProviderProxyConfig(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export function providerProxyStatus(config: ProviderProxyConfig, configPath = CONFIG_PATH): string {
  const entries = Object.entries(config.providers).sort(([a], [b]) => a.localeCompare(b));
  const state = config.enabled ? "enabled" : "disabled";
  const lines = [`Provider proxy: ${state}`, `Config: ${displayPath(configPath)}`];

  if (!entries.length) {
    lines.push("", "No provider overrides configured.");
  } else {
    lines.push("", "Provider overrides:");
    for (const [provider, baseUrl] of entries) lines.push(`  ${provider} -> ${baseUrl}`);
  }

  return lines.join("\n");
}

export function applyProviderProxyConfig(pi: Pick<ExtensionAPI, "registerProvider">, config: ProviderProxyConfig): string[] {
  if (!config.enabled) return [];
  const applied: string[] = [];
  for (const [provider, baseUrl] of Object.entries(config.providers)) {
    pi.registerProvider(provider, { baseUrl });
    applied.push(provider);
  }
  return applied;
}

function showOutput(ctx: any, output: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx?.ui?.notify) ctx.ui.notify(output, level);
  else console.log(output);
}

function availableProviderIds(ctx: any): string[] {
  const ids = new Set<string>();
  for (const model of ctx?.modelRegistry?.getAll?.() ?? []) {
    if (typeof model?.provider === "string" && model.provider) ids.add(model.provider);
  }
  if (typeof ctx?.model?.provider === "string" && ctx.model.provider) ids.add(ctx.model.provider);
  return [...ids].sort((a, b) => a.localeCompare(b));
}

async function promptProvider(ctx: any): Promise<string | undefined> {
  const ids = availableProviderIds(ctx);
  if (!ctx?.hasUI || !ctx?.ui?.select) throw new Error("Usage: /proxy add <provider> <baseUrl>");
  if (!ids.length) {
    const typed = await ctx.ui.input("Provider id", "openai");
    return typed ? normalizeProviderId(typed) : undefined;
  }
  const selected = await ctx.ui.select("Provider to proxy", ids);
  return selected ? normalizeProviderId(selected) : undefined;
}

async function promptBaseUrl(ctx: any, provider: string, current?: string): Promise<string | undefined> {
  if (!ctx?.hasUI || !ctx?.ui?.input) throw new Error("Usage: /proxy add <provider> <baseUrl>");
  const placeholder = current || recommendedProviderBaseUrl(provider);
  const value = await ctx.ui.input(`Base URL for ${provider}`, placeholder);
  return value ? normalizeBaseUrl(value) : undefined;
}

function parseArgs(args: string): string[] {
  return (args ?? "").trim().split(/\s+/).filter(Boolean);
}

export function registerProviderProxyExtension(pi: ExtensionAPI, options: ProviderProxyOptions = {}): void {
  const configPath = options.configPath ?? CONFIG_PATH;

  let config: ProviderProxyConfig = { ...DEFAULT_CONFIG, providers: {} };
  let loadError: string | undefined;
  const appliedProviders = new Set<string>();

  const load = () => {
    config = loadProviderProxyConfig(configPath);
    return config;
  };

  const save = () => saveProviderProxyConfig(config, configPath);

  const apply = () => {
    for (const provider of applyProviderProxyConfig(pi, config)) appliedProviders.add(provider);
  };

  const unapply = (providers = [...appliedProviders]) => {
    const unregister = (pi as any).unregisterProvider;
    if (typeof unregister !== "function") return;
    for (const provider of providers) {
      unregister(provider);
      appliedProviders.delete(provider);
    }
  };

  try {
    load();
    apply();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  pi.registerCommand("proxy", {
    description: "Map provider baseUrls to externally managed relay URLs",
    handler: async (args: string, ctx: any) => {
      const [subcommandRaw, ...rest] = parseArgs(args);
      const subcommand = subcommandRaw?.toLowerCase();

      try {
        if (loadError) {
          showOutput(ctx, `Provider proxy config error: ${loadError}\nConfig: ${displayPath(configPath)}`, "error");
          loadError = undefined;
          load();
        } else {
          load();
        }

        if (!subcommand || subcommand === "status") {
          showOutput(ctx, `${providerProxyStatus(config, configPath)}\n\n${COMMANDS}`);
          return;
        }

        if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
          showOutput(ctx, COMMANDS);
          return;
        }

        if (subcommand === "on" || subcommand === "enable") {
          config.enabled = true;
          save();
          apply();
          showOutput(ctx, `Provider proxy enabled.\n\n${providerProxyStatus(config, configPath)}`);
          return;
        }

        if (subcommand === "off" || subcommand === "disable") {
          config.enabled = false;
          save();
          unapply();
          showOutput(ctx, `Provider proxy disabled.\n\n${providerProxyStatus(config, configPath)}`);
          return;
        }

        if (subcommand === "add" || subcommand === "set") {
          const provider = rest[0] ? normalizeProviderId(rest[0]) : await promptProvider(ctx);
          if (!provider) return;
          const baseUrl = rest[1] ? normalizeBaseUrl(rest[1]) : await promptBaseUrl(ctx, provider, config.providers[provider]);
          if (!baseUrl) return;
          config.enabled = true;
          config.providers[provider] = baseUrl;
          save();
          pi.registerProvider(provider, { baseUrl });
          appliedProviders.add(provider);
          showOutput(ctx, `Provider proxy set: ${provider} -> ${baseUrl}`);
          return;
        }

        if (subcommand === "setup") {
          do {
            const provider = await promptProvider(ctx);
            if (!provider) break;
            const baseUrl = await promptBaseUrl(ctx, provider, config.providers[provider]);
            if (!baseUrl) break;
            config.enabled = true;
            config.providers[provider] = baseUrl;
            pi.registerProvider(provider, { baseUrl });
            appliedProviders.add(provider);
          } while (await ctx.ui.confirm("Provider proxy", "Add another provider override?"));
          save();
          showOutput(ctx, providerProxyStatus(config, configPath));
          return;
        }

        if (subcommand === "remove" || subcommand === "rm" || subcommand === "delete") {
          let provider = rest[0] ? normalizeProviderId(rest[0]) : undefined;
          const configured = Object.keys(config.providers).sort((a, b) => a.localeCompare(b));
          if (!provider) {
            if (!configured.length) {
              showOutput(ctx, "No provider overrides configured.");
              return;
            }
            if (!ctx?.hasUI || !ctx?.ui?.select) throw new Error("Usage: /proxy remove <provider>");
            provider = await ctx.ui.select("Remove provider override", configured);
          }
          if (!provider) return;
          if (!Object.hasOwn(config.providers, provider)) throw new Error(`No provider proxy configured for ${provider}`);
          delete config.providers[provider];
          save();
          unapply([provider]);
          showOutput(ctx, `Provider proxy removed: ${provider}`);
          return;
        }

        throw new Error(`Unknown /proxy command: ${subcommand}\n\n${COMMANDS}`);
      } catch (error) {
        showOutput(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    if (loadError) {
      ctx.ui?.notify?.(`Provider proxy config error: ${loadError}`, "error");
      return;
    }
    const count = config.enabled ? Object.keys(config.providers).length : 0;
    ctx.ui?.setStatus?.("provider-proxy", count ? `proxy:${count}` : undefined);
  });

  pi.on("session_shutdown", async () => {
    appliedProviders.clear();
  });
}

export default registerProviderProxyExtension;
