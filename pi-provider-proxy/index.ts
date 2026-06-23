import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "@earendil-works/pi-ai/oauth";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { pipPath } from "../pip-common/index.ts";

export interface ProviderProxyConfig {
  enabled: boolean;
  providers: Record<string, string>;
  auth: Record<string, string>;
}

export interface ProviderProxyOptions {
  configPath?: string;
}

export interface ProviderRouteHint {
  provider: string;
  path: string;
  note?: string;
}

interface CallbackServerHandle {
  close: () => void;
  cancelWait: () => void;
  waitForCode: () => Promise<{ code: string; state?: string } | null>;
}

type ProviderProxyOAuthLoginCallbacks = Omit<OAuthLoginCallbacks, "onDeviceCode"> & {
  onDeviceCode?: OAuthLoginCallbacks["onDeviceCode"];
};

type DeviceCodePollResult<T> = { status: "pending" } | { status: "slow_down" } | { status: "failed"; message: string } | { status: "complete"; value: T };

const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_DIRECT_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_AUTHORIZE_URL = `${OPENAI_CODEX_DIRECT_AUTH_BASE_URL}/oauth/authorize`;
const OPENAI_CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_CODEX_DEVICE_REDIRECT_URI = `${OPENAI_CODEX_DIRECT_AUTH_BASE_URL}/deviceauth/callback`;
const OPENAI_CODEX_DEVICE_VERIFICATION_URI = `${OPENAI_CODEX_DIRECT_AUTH_BASE_URL}/codex/device`;
const OPENAI_CODEX_SCOPE = "openid profile email offline_access";
const OPENAI_CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";
const OPENAI_CODEX_DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const OPENAI_CODEX_BROWSER_LOGIN_METHOD = "browser";
const OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD = "device_code";

const ANTHROPIC_CLIENT_ID = Buffer.from("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl", "base64").toString("utf8");
const ANTHROPIC_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_REDIRECT_URI = "http://localhost:53692/callback";
const ANTHROPIC_SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export const CONFIG_PATH = pipPath("provider-proxy.json");
export const DEFAULT_CONFIG: ProviderProxyConfig = { enabled: false, providers: {}, auth: {} };
export const SSH_TUNNEL_HINT = "ssh -N -L 127.0.0.1:9898:127.0.0.1:9898 user@server";
export const DEFAULT_RELAY_BASE_URL = "http://127.0.0.1:9898";
export const DOCKER_HOST_RELAY_BASE_URL = "http://172.17.0.1:9898";
export const PROVIDER_ROUTE_HINTS: ProviderRouteHint[] = [
  { provider: "openai", path: "/openai/v1" },
  { provider: "openai-codex", path: "/chatgpt/backend-api" },
  { provider: "anthropic", path: "/anthropic" },
];
export const PROVIDER_AUTH_ROUTE_HINTS: ProviderRouteHint[] = [
  { provider: "openai-codex", path: "/openai-auth", note: "Pi-side auth.openai.com token/device calls" },
  { provider: "anthropic", path: "/anthropic-auth", note: "Pi-side platform.claude.com token calls" },
];

const COMMANDS = `Map Pi providers to relay URLs.

This command only changes provider API baseUrls and optional Pi-side OAuth
relay URLs. It does not start SSH, run a relay, store credentials, or replace
provider auth/model handling.

Commands:
  /proxy                              Show status, commands, and SSH tunnel hint
  /proxy status                       Show current provider API/auth relay maps
  /proxy setup                        Add or update provider API baseUrls interactively
  /proxy add <provider> <url>         Add or update one provider API baseUrl
  /proxy remove <provider>            Remove one provider API baseUrl
  /proxy auth add <provider> <url>    Add or update one provider auth relay URL
  /proxy auth remove <provider>       Remove one provider auth relay URL
  /proxy on                           Enable configured maps
  /proxy off                          Disable configured maps and restore providers

Relay base examples:
  native Pi / same namespace:     ${DEFAULT_RELAY_BASE_URL}
  Pi in Docker, tunnel on host:   ${DOCKER_HOST_RELAY_BASE_URL}

${providerRouteHelp()}

${providerAuthRouteHelp()}

Relay route contract:
  /openai/*          -> https://api.openai.com/*
  /chatgpt/*         -> https://chatgpt.com/*
  /anthropic/*       -> https://api.anthropic.com/*
  /openai-auth/*     -> https://auth.openai.com/*
  /anthropic-auth/*  -> https://platform.claude.com/*

Auth relay URLs are for Pi-side token/device HTTP calls. Browser login pages
may still open provider web URLs such as claude.ai or auth.openai.com.

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
  return value.replace(/\/+$/, "");
}

function joinUrlPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function recommendedProviderBaseUrl(provider: string, relayBaseUrl = DEFAULT_RELAY_BASE_URL): string {
  const normalizedProvider = normalizeProviderId(provider);
  const hint = PROVIDER_ROUTE_HINTS.find((entry) => entry.provider === normalizedProvider);
  return joinUrlPath(normalizeBaseUrl(relayBaseUrl), hint?.path ?? `/${normalizedProvider}`);
}

export function recommendedProviderAuthUrl(provider: string, relayBaseUrl = DEFAULT_RELAY_BASE_URL): string {
  const normalizedProvider = normalizeProviderId(provider);
  const hint = PROVIDER_AUTH_ROUTE_HINTS.find((entry) => entry.provider === normalizedProvider);
  if (!hint) throw new Error(`No auth relay route is defined for provider: ${normalizedProvider}`);
  return joinUrlPath(normalizeBaseUrl(relayBaseUrl), hint.path);
}

export function providerRouteHelp(relayBaseUrl = "<relay>"): string {
  const providerWidth = Math.max(...PROVIDER_ROUTE_HINTS.map((entry) => entry.provider.length));
  const lines = ["Provider API baseUrls to configure:"];
  for (const entry of PROVIDER_ROUTE_HINTS) {
    const provider = entry.provider.padEnd(providerWidth);
    const url = relayBaseUrl === "<relay>" ? joinUrlPath(relayBaseUrl, entry.path) : recommendedProviderBaseUrl(entry.provider, relayBaseUrl);
    lines.push(`  ${provider}  ${url}${entry.note ? `  (${entry.note})` : ""}`);
  }
  return lines.join("\n");
}

export function providerAuthRouteHelp(relayBaseUrl = "<relay>"): string {
  const providerWidth = Math.max(...PROVIDER_AUTH_ROUTE_HINTS.map((entry) => entry.provider.length));
  const lines = ["Provider auth relay URLs to configure when /login or token refresh is blocked:"];
  for (const entry of PROVIDER_AUTH_ROUTE_HINTS) {
    const provider = entry.provider.padEnd(providerWidth);
    const url = relayBaseUrl === "<relay>" ? joinUrlPath(relayBaseUrl, entry.path) : recommendedProviderAuthUrl(entry.provider, relayBaseUrl);
    lines.push(`  ${provider}  ${url}${entry.note ? `  (${entry.note})` : ""}`);
  }
  return lines.join("\n");
}

function normalizeUrlMap(raw: unknown, label: string): Record<string, string> {
  const entriesRaw = isRecord(raw) ? raw : {};
  const entries: Record<string, string> = {};
  for (const [providerKey, entry] of Object.entries(entriesRaw)) {
    const provider = normalizeProviderId(providerKey);
    const baseUrl = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.baseUrl === "string" ? entry.baseUrl : undefined;
    if (baseUrl === undefined) throw new Error(`Invalid provider proxy ${label} entry for ${provider}; expected a baseUrl string`);
    entries[provider] = normalizeBaseUrl(baseUrl);
  }
  return entries;
}

export function normalizeProviderProxyConfig(raw: unknown): ProviderProxyConfig {
  if (!isRecord(raw)) return { ...DEFAULT_CONFIG, providers: {}, auth: {} };
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled;
  return {
    enabled,
    providers: normalizeUrlMap(raw.providers, "provider"),
    auth: normalizeUrlMap(raw.auth, "auth"),
  };
}

export function loadProviderProxyConfig(path = CONFIG_PATH): ProviderProxyConfig {
  if (!existsSync(path)) return { ...DEFAULT_CONFIG, providers: {}, auth: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return normalizeProviderProxyConfig(parsed);
}

export function saveProviderProxyConfig(config: ProviderProxyConfig, path = CONFIG_PATH): void {
  const normalized = normalizeProviderProxyConfig(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export function providerProxyStatus(config: ProviderProxyConfig, configPath = CONFIG_PATH): string {
  const providerEntries = Object.entries(config.providers).sort(([a], [b]) => a.localeCompare(b));
  const authEntries = Object.entries(config.auth).sort(([a], [b]) => a.localeCompare(b));
  const state = config.enabled ? "enabled" : "disabled";
  const lines = [`Provider proxy: ${state}`, `Config: ${displayPath(configPath)}`];

  if (!providerEntries.length) {
    lines.push("", "No provider API baseUrl overrides configured.");
  } else {
    lines.push("", "Provider API baseUrls:");
    for (const [provider, baseUrl] of providerEntries) lines.push(`  ${provider} -> ${baseUrl}`);
  }

  if (!authEntries.length) {
    lines.push("", "No provider auth relay URLs configured.");
  } else {
    lines.push("", "Provider auth relay URLs:");
    for (const [provider, baseUrl] of authEntries) lines.push(`  ${provider} -> ${baseUrl}`);
  }

  lines.push("", "This extension does not manage SSH credentials or tunnels.", "Start your tunnel separately, for example:", `  ${SSH_TUNNEL_HINT}`);
  return lines.join("\n");
}

function configuredProviderIds(config: ProviderProxyConfig): string[] {
  return [...new Set([...Object.keys(config.providers), ...Object.keys(config.auth)])].sort((a, b) => a.localeCompare(b));
}

export function providerRegistrationConfig(provider: string, config: ProviderProxyConfig): Record<string, unknown> | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  const registration: Record<string, unknown> = {};
  const providerBaseUrl = config.providers[normalizedProvider];
  const authBaseUrl = config.auth[normalizedProvider];
  if (providerBaseUrl) registration.baseUrl = providerBaseUrl;
  if (authBaseUrl) registration.oauth = createRelayedOAuthProvider(normalizedProvider, authBaseUrl);
  return Object.keys(registration).length ? registration : undefined;
}

export function applyProviderProxyConfig(pi: Pick<ExtensionAPI, "registerProvider">, config: ProviderProxyConfig): string[] {
  if (!config.enabled) return [];
  const applied: string[] = [];
  for (const provider of configuredProviderIds(config)) {
    const registration = providerRegistrationConfig(provider, config);
    if (!registration) continue;
    pi.registerProvider(provider, registration as any);
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

async function promptAuthProvider(ctx: any): Promise<string | undefined> {
  if (!ctx?.hasUI || !ctx?.ui?.select) throw new Error("Usage: /proxy auth add <provider> <authRelayUrl>");
  const selected = await ctx.ui.select(
    "Provider auth relay",
    PROVIDER_AUTH_ROUTE_HINTS.map((entry) => entry.provider),
  );
  return selected ? normalizeProviderId(selected) : undefined;
}

async function promptBaseUrl(ctx: any, provider: string, current?: string): Promise<string | undefined> {
  if (!ctx?.hasUI || !ctx?.ui?.input) throw new Error("Usage: /proxy add <provider> <baseUrl>");
  const placeholder = current || recommendedProviderBaseUrl(provider);
  const value = await ctx.ui.input(`API baseUrl for ${provider}`, placeholder);
  return value ? normalizeBaseUrl(value) : undefined;
}

async function promptAuthBaseUrl(ctx: any, provider: string, current?: string): Promise<string | undefined> {
  if (!ctx?.hasUI || !ctx?.ui?.input) throw new Error("Usage: /proxy auth add <provider> <authRelayUrl>");
  const placeholder = current || recommendedProviderAuthUrl(provider);
  const value = await ctx.ui.input(`Auth relay URL for ${provider}`, placeholder);
  return value ? normalizeBaseUrl(value) : undefined;
}

function parseArgs(args: string): string[] {
  return (args ?? "").trim().split(/\s+/).filter(Boolean);
}

function assertSupportedAuthRelayProvider(provider: string): void {
  if (!PROVIDER_AUTH_ROUTE_HINTS.some((entry) => entry.provider === provider)) {
    throw new Error(`No auth relay support for ${provider}. Supported providers: ${PROVIDER_AUTH_ROUTE_HINTS.map((entry) => entry.provider).join(", ")}`);
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Not a URL.
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}

function getCallbackHost(): string {
  return typeof process !== "undefined" ? process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1" : "127.0.0.1";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Login cancelled"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Login cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function pollDeviceCodeFlow<T>(options: {
  intervalSeconds?: number;
  expiresInSeconds?: number;
  signal?: AbortSignal;
  poll: () => Promise<DeviceCodePollResult<T>>;
}): Promise<T> {
  let intervalSeconds = Math.max(1, options.intervalSeconds ?? 5);
  const expiresAt = Date.now() + Math.max(1, options.expiresInSeconds ?? 15 * 60) * 1000;
  while (Date.now() < expiresAt) {
    if (options.signal?.aborted) throw new Error("Login cancelled");
    const result = await options.poll();
    if (result.status === "complete") return result.value;
    if (result.status === "failed") throw new Error(result.message);
    if (result.status === "slow_down") intervalSeconds += 5;
    await sleep(intervalSeconds * 1000, options.signal);
  }
  throw new Error("Device code login timed out");
}

function startCallbackServer(options: {
  port: number;
  path: string;
  expectedState: string;
  requireState?: boolean;
  successMessage: string;
}): Promise<CallbackServerHandle> {
  let server: Server | undefined;
  let settleWait: ((value: { code: string; state?: string } | null) => void) | undefined;
  const waitForCodePromise = new Promise<{ code: string; state?: string } | null>((resolve) => {
    let settled = false;
    settleWait = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  return new Promise((resolve) => {
    server = createServer((req, res) => {
      try {
        const url = new URL(req.url || "", "http://localhost");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state") ?? undefined;
        const error = url.searchParams.get("error");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        if (url.pathname !== options.path) {
          res.statusCode = 404;
          res.end("Callback route not found.");
          return;
        }
        if (error) {
          res.statusCode = 400;
          res.end(`Authentication did not complete: ${error}`);
          return;
        }
        if (!code) {
          res.statusCode = 400;
          res.end("Missing authorization code.");
          return;
        }
        if (options.requireState !== false && state !== options.expectedState) {
          res.statusCode = 400;
          res.end("State mismatch.");
          return;
        }
        res.statusCode = 200;
        res.end(options.successMessage);
        settleWait?.({ code, state });
      } catch {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Internal error");
      }
    });

    const handle: CallbackServerHandle = {
      close: () => {
        try {
          server?.close();
        } catch {
          // ignore
        }
      },
      cancelWait: () => settleWait?.(null),
      waitForCode: () => waitForCodePromise,
    };

    server
      .listen(options.port, getCallbackHost(), () => resolve(handle))
      .on("error", () => {
        settleWait?.(null);
        resolve(handle);
      });
  });
}

async function fetchWithLoginCancellation(input: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (init.signal?.aborted) throw new Error("Login cancelled");
    throw error;
  }
}

async function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchWithLoginCancellation(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseText || response.statusText}`);
  return responseText ? JSON.parse(responseText) : {};
}

async function postForm(url: string, body: URLSearchParams, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchWithLoginCancellation(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    signal,
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseText || response.statusText}`);
  return responseText ? JSON.parse(responseText) : {};
}

function decodeJwt(token: string): any | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function readOpenAITokenResponse(raw: unknown): OAuthCredentials {
  const json = raw as any;
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error(`OpenAI Codex token response missing fields: ${JSON.stringify(json)}`);
  }
  const payload = decodeJwt(json.access_token);
  const accountId = payload?.[OPENAI_CODEX_JWT_CLAIM_PATH]?.chatgpt_account_id;
  if (!accountId) throw new Error("Failed to extract accountId from token");
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId,
  };
}

function readAnthropicTokenResponse(raw: unknown): OAuthCredentials {
  const json = raw as any;
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error(`Anthropic token response missing fields: ${JSON.stringify(json)}`);
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000 - 5 * 60 * 1000,
  };
}

async function exchangeOpenAICode(authBaseUrl: string, code: string, verifier: string, redirectUri: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  return readOpenAITokenResponse(
    await postForm(
      joinUrlPath(authBaseUrl, "/oauth/token"),
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OPENAI_CODEX_CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
      signal,
    ),
  );
}

async function refreshOpenAIToken(authBaseUrl: string, refreshToken: string): Promise<OAuthCredentials> {
  return readOpenAITokenResponse(
    await postForm(
      joinUrlPath(authBaseUrl, "/oauth/token"),
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OPENAI_CODEX_CLIENT_ID,
      }),
    ),
  );
}

async function startOpenAIDeviceAuth(authBaseUrl: string, signal?: AbortSignal): Promise<{ deviceAuthId: string; userCode: string; intervalSeconds?: number }> {
  const json = (await postJson(joinUrlPath(authBaseUrl, "/api/accounts/deviceauth/usercode"), { client_id: OPENAI_CODEX_CLIENT_ID }, signal)) as any;
  const intervalSeconds = typeof json?.interval === "string" ? Number(json.interval.trim()) : json?.interval;
  if (!json?.device_auth_id || !json.user_code || (intervalSeconds !== undefined && typeof intervalSeconds !== "number")) {
    throw new Error(`Invalid OpenAI Codex device code response: ${JSON.stringify(json)}`);
  }
  return { deviceAuthId: json.device_auth_id, userCode: json.user_code, intervalSeconds };
}

async function pollOpenAIDeviceAuth(
  authBaseUrl: string,
  device: { deviceAuthId: string; userCode: string; intervalSeconds?: number },
  signal?: AbortSignal,
): Promise<{ authorizationCode: string; codeVerifier: string }> {
  return pollDeviceCodeFlow<{ authorizationCode: string; codeVerifier: string }>({
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: OPENAI_CODEX_DEVICE_CODE_TIMEOUT_SECONDS,
    signal,
    poll: async () => {
      const response = await fetchWithLoginCancellation(joinUrlPath(authBaseUrl, "/api/accounts/deviceauth/token"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
        signal,
      });
      const responseText = await response.text();
      if (response.ok) {
        const json = responseText ? JSON.parse(responseText) : {};
        if (!json?.authorization_code || !json.code_verifier) {
          return { status: "failed", message: `Invalid OpenAI Codex device auth token response: ${JSON.stringify(json)}` };
        }
        return { status: "complete", value: { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier } };
      }
      let errorCode: string | undefined;
      try {
        const json = JSON.parse(responseText);
        const error = json?.error;
        errorCode = typeof error === "object" ? error?.code : error;
      } catch {
        // ignore
      }
      if (response.status === 403 || response.status === 404 || errorCode === "deviceauth_authorization_pending") return { status: "pending" };
      if (errorCode === "slow_down") return { status: "slow_down" };
      return { status: "failed", message: `OpenAI Codex device auth failed with status ${response.status}${responseText ? `: ${responseText}` : ""}` };
    },
  });
}

async function loginOpenAICodexWithAuthRelay(authBaseUrl: string, callbacks: ProviderProxyOAuthLoginCallbacks): Promise<OAuthCredentials> {
  const loginMethod = callbacks.onSelect
    ? await callbacks.onSelect({
        message: "Select OpenAI Codex login method:",
        options: [
          { id: OPENAI_CODEX_BROWSER_LOGIN_METHOD, label: "Browser login (default)" },
          { id: OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD, label: "Device code login (headless)" },
        ],
      })
    : OPENAI_CODEX_BROWSER_LOGIN_METHOD;
  if (!loginMethod) throw new Error("Login cancelled");

  if (loginMethod === OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD) {
    if (!callbacks.onDeviceCode) throw new Error("Device code login is not supported by this Pi version");
    const device = await startOpenAIDeviceAuth(authBaseUrl, callbacks.signal);
    callbacks.onDeviceCode({
      userCode: device.userCode,
      verificationUri: OPENAI_CODEX_DEVICE_VERIFICATION_URI,
      intervalSeconds: device.intervalSeconds,
      expiresInSeconds: OPENAI_CODEX_DEVICE_CODE_TIMEOUT_SECONDS,
    });
    const code = await pollOpenAIDeviceAuth(authBaseUrl, device, callbacks.signal);
    return exchangeOpenAICode(authBaseUrl, code.authorizationCode, code.codeVerifier, OPENAI_CODEX_DEVICE_REDIRECT_URI, callbacks.signal);
  }

  if (loginMethod !== OPENAI_CODEX_BROWSER_LOGIN_METHOD) throw new Error(`Unknown OpenAI Codex login method: ${loginMethod}`);

  const { verifier, challenge } = createPkce();
  const state = randomBytes(16).toString("hex");
  const url = new URL(OPENAI_CODEX_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OPENAI_CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", OPENAI_CODEX_REDIRECT_URI);
  url.searchParams.set("scope", OPENAI_CODEX_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "pi");

  const server = await startCallbackServer({
    port: 1455,
    path: "/auth/callback",
    expectedState: state,
    successMessage: "OpenAI authentication completed. You can close this window.",
  });
  callbacks.onAuth({ url: url.toString(), instructions: "Complete login in your browser. Token exchange will use the configured auth relay." });

  let code: string | undefined;
  try {
    if (callbacks.onManualCodeInput) {
      let manualInput: string | undefined;
      let manualError: Error | undefined;
      const manualPromise = callbacks
        .onManualCodeInput()
        .then((input) => {
          manualInput = input;
          server.cancelWait();
        })
        .catch((error) => {
          manualError = error instanceof Error ? error : new Error(String(error));
          server.cancelWait();
        });
      const result = await server.waitForCode();
      if (manualError) throw manualError;
      if (result?.code) code = result.code;
      else if (manualInput) {
        const parsed = parseAuthorizationInput(manualInput);
        if (parsed.state && parsed.state !== state) throw new Error("State mismatch");
        code = parsed.code;
      }
      if (!code) {
        await manualPromise;
        if (manualError) throw manualError;
        if (manualInput) {
          const parsed = parseAuthorizationInput(manualInput);
          if (parsed.state && parsed.state !== state) throw new Error("State mismatch");
          code = parsed.code;
        }
      }
    } else {
      const result = await server.waitForCode();
      if (result?.code) code = result.code;
    }
    if (!code) {
      const input = await callbacks.onPrompt({ message: "Paste the authorization code (or full redirect URL):" });
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) throw new Error("State mismatch");
      code = parsed.code;
    }
    if (!code) throw new Error("Missing authorization code");
    return exchangeOpenAICode(authBaseUrl, code, verifier, OPENAI_CODEX_REDIRECT_URI, callbacks.signal);
  } finally {
    server.close();
  }
}

async function exchangeAnthropicCode(authBaseUrl: string, code: string, state: string, verifier: string, redirectUri: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  return readAnthropicTokenResponse(
    await postJson(
      joinUrlPath(authBaseUrl, "/v1/oauth/token"),
      {
        grant_type: "authorization_code",
        client_id: ANTHROPIC_CLIENT_ID,
        code,
        state,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      signal,
    ),
  );
}

async function refreshAnthropicWithAuthRelay(authBaseUrl: string, refreshToken: string): Promise<OAuthCredentials> {
  return readAnthropicTokenResponse(
    await postJson(joinUrlPath(authBaseUrl, "/v1/oauth/token"), {
      grant_type: "refresh_token",
      client_id: ANTHROPIC_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  );
}

async function loginAnthropicWithAuthRelay(authBaseUrl: string, callbacks: ProviderProxyOAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { verifier, challenge } = createPkce();
  const server = await startCallbackServer({
    port: 53692,
    path: "/callback",
    expectedState: verifier,
    successMessage: "Anthropic authentication completed. You can close this window.",
  });
  let code: string | undefined;
  let state: string | undefined;
  let redirectUriForExchange = ANTHROPIC_REDIRECT_URI;

  try {
    const authParams = new URLSearchParams({
      code: "true",
      client_id: ANTHROPIC_CLIENT_ID,
      response_type: "code",
      redirect_uri: ANTHROPIC_REDIRECT_URI,
      scope: ANTHROPIC_SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: verifier,
    });
    callbacks.onAuth({
      url: `${ANTHROPIC_AUTHORIZE_URL}?${authParams.toString()}`,
      instructions: "Complete login in your browser. Token exchange will use the configured auth relay.",
    });

    if (callbacks.onManualCodeInput) {
      let manualInput: string | undefined;
      let manualError: Error | undefined;
      const manualPromise = callbacks
        .onManualCodeInput()
        .then((input) => {
          manualInput = input;
          server.cancelWait();
        })
        .catch((error) => {
          manualError = error instanceof Error ? error : new Error(String(error));
          server.cancelWait();
        });
      const result = await server.waitForCode();
      if (manualError) throw manualError;
      if (result?.code) {
        code = result.code;
        state = result.state;
        redirectUriForExchange = ANTHROPIC_REDIRECT_URI;
      } else if (manualInput) {
        const parsed = parseAuthorizationInput(manualInput);
        if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
        code = parsed.code;
        state = parsed.state ?? verifier;
      }
      if (!code) {
        await manualPromise;
        if (manualError) throw manualError;
        if (manualInput) {
          const parsed = parseAuthorizationInput(manualInput);
          if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
          code = parsed.code;
          state = parsed.state ?? verifier;
        }
      }
    } else {
      const result = await server.waitForCode();
      if (result?.code) {
        code = result.code;
        state = result.state;
        redirectUriForExchange = ANTHROPIC_REDIRECT_URI;
      }
    }

    if (!code) {
      const input = await callbacks.onPrompt({ message: "Paste the authorization code or full redirect URL:", placeholder: ANTHROPIC_REDIRECT_URI });
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
      code = parsed.code;
      state = parsed.state ?? verifier;
    }
    if (!code) throw new Error("Missing authorization code");
    if (!state) throw new Error("Missing OAuth state");
    callbacks.onProgress?.("Exchanging authorization code for tokens through auth relay...");
    return exchangeAnthropicCode(authBaseUrl, code, state, verifier, redirectUriForExchange, callbacks.signal);
  } finally {
    server.close();
  }
}

export function createRelayedOAuthProvider(provider: string, authBaseUrl: string): Omit<OAuthProviderInterface, "id"> {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedAuthBaseUrl = normalizeBaseUrl(authBaseUrl);
  assertSupportedAuthRelayProvider(normalizedProvider);

  if (normalizedProvider === "openai-codex") {
    return {
      name: "ChatGPT Plus/Pro (Codex Subscription)",
      usesCallbackServer: true,
      login: (callbacks) => loginOpenAICodexWithAuthRelay(normalizedAuthBaseUrl, callbacks),
      refreshToken: (credentials) => refreshOpenAIToken(normalizedAuthBaseUrl, credentials.refresh),
      getApiKey: (credentials) => credentials.access,
    };
  }

  if (normalizedProvider === "anthropic") {
    return {
      name: "Anthropic (Claude Pro/Max)",
      usesCallbackServer: true,
      login: (callbacks) => loginAnthropicWithAuthRelay(normalizedAuthBaseUrl, callbacks),
      refreshToken: (credentials) => refreshAnthropicWithAuthRelay(normalizedAuthBaseUrl, credentials.refresh),
      getApiKey: (credentials) => credentials.access,
    };
  }

  throw new Error(`No auth relay support for ${normalizedProvider}`);
}

export function registerProviderProxyExtension(pi: ExtensionAPI, options: ProviderProxyOptions = {}): void {
  const configPath = options.configPath ?? CONFIG_PATH;

  let config: ProviderProxyConfig = { ...DEFAULT_CONFIG, providers: {}, auth: {} };
  let loadError: string | undefined;
  const appliedProviders = new Set<string>();

  const load = () => {
    config = loadProviderProxyConfig(configPath);
    return config;
  };

  const save = () => saveProviderProxyConfig(config, configPath);

  const unapply = (providers = [...appliedProviders]) => {
    const unregister = (pi as any).unregisterProvider;
    if (typeof unregister !== "function") return;
    for (const provider of providers) {
      unregister(provider);
      appliedProviders.delete(provider);
    }
  };

  const applyOne = (provider: string) => {
    const registration = providerRegistrationConfig(provider, config);
    if (!registration || !config.enabled) return;
    pi.registerProvider(provider, registration as any);
    appliedProviders.add(provider);
  };

  const reapplyOne = (provider: string) => {
    unapply([provider]);
    applyOne(provider);
  };

  const apply = () => {
    for (const provider of applyProviderProxyConfig(pi, config)) appliedProviders.add(provider);
  };

  const updateStatus = (ctx: any) => {
    ctx.ui?.setStatus?.("provider-proxy", config.enabled ? "proxy: on" : undefined);
  };

  try {
    load();
    apply();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  pi.registerCommand("proxy", {
    description: "Map provider API/auth baseUrls to externally managed relay URLs",
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
        updateStatus(ctx);

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
          updateStatus(ctx);
          showOutput(ctx, `Provider proxy enabled.\n\n${providerProxyStatus(config, configPath)}`);
          return;
        }

        if (subcommand === "off" || subcommand === "disable") {
          config.enabled = false;
          save();
          unapply();
          updateStatus(ctx);
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
          reapplyOne(provider);
          updateStatus(ctx);
          showOutput(ctx, `Provider API baseUrl set: ${provider} -> ${baseUrl}`);
          return;
        }

        if (subcommand === "auth") {
          const [authSubcommandRaw, ...authRest] = rest;
          const authSubcommand = authSubcommandRaw?.toLowerCase();
          if (!authSubcommand || authSubcommand === "status") {
            showOutput(ctx, providerProxyStatus(config, configPath));
            return;
          }
          if (authSubcommand === "add" || authSubcommand === "set") {
            const provider = authRest[0] ? normalizeProviderId(authRest[0]) : await promptAuthProvider(ctx);
            if (!provider) return;
            assertSupportedAuthRelayProvider(provider);
            const authBaseUrl = authRest[1] ? normalizeBaseUrl(authRest[1]) : await promptAuthBaseUrl(ctx, provider, config.auth[provider]);
            if (!authBaseUrl) return;
            config.enabled = true;
            config.auth[provider] = authBaseUrl;
            save();
            reapplyOne(provider);
            updateStatus(ctx);
            showOutput(ctx, `Provider auth relay set: ${provider} -> ${authBaseUrl}`);
            return;
          }
          if (authSubcommand === "remove" || authSubcommand === "rm" || authSubcommand === "delete") {
            let provider = authRest[0] ? normalizeProviderId(authRest[0]) : undefined;
            const configured = Object.keys(config.auth).sort((a, b) => a.localeCompare(b));
            if (!provider) {
              if (!configured.length) {
                showOutput(ctx, "No provider auth relay URLs configured.");
                return;
              }
              if (!ctx?.hasUI || !ctx?.ui?.select) throw new Error("Usage: /proxy auth remove <provider>");
              provider = await ctx.ui.select("Remove provider auth relay", configured);
            }
            if (!provider) return;
            if (!Object.hasOwn(config.auth, provider)) throw new Error(`No provider auth relay configured for ${provider}`);
            delete config.auth[provider];
            save();
            reapplyOne(provider);
            showOutput(ctx, `Provider auth relay removed: ${provider}`);
            return;
          }
          throw new Error(`Unknown /proxy auth command: ${authSubcommand}\n\n${COMMANDS}`);
        }

        if (subcommand === "setup") {
          do {
            const provider = await promptProvider(ctx);
            if (!provider) break;
            const baseUrl = await promptBaseUrl(ctx, provider, config.providers[provider]);
            if (!baseUrl) break;
            config.enabled = true;
            config.providers[provider] = baseUrl;
            reapplyOne(provider);
            updateStatus(ctx);
          } while (await ctx.ui.confirm("Provider proxy", "Add another provider API baseUrl?"));
          save();
          showOutput(ctx, providerProxyStatus(config, configPath));
          return;
        }

        if (subcommand === "remove" || subcommand === "rm" || subcommand === "delete") {
          let provider = rest[0] ? normalizeProviderId(rest[0]) : undefined;
          const configured = Object.keys(config.providers).sort((a, b) => a.localeCompare(b));
          if (!provider) {
            if (!configured.length) {
              showOutput(ctx, "No provider API baseUrl overrides configured.");
              return;
            }
            if (!ctx?.hasUI || !ctx?.ui?.select) throw new Error("Usage: /proxy remove <provider>");
            provider = await ctx.ui.select("Remove provider API baseUrl", configured);
          }
          if (!provider) return;
          if (!Object.hasOwn(config.providers, provider)) throw new Error(`No provider API baseUrl configured for ${provider}`);
          delete config.providers[provider];
          save();
          reapplyOne(provider);
          showOutput(ctx, `Provider API baseUrl removed: ${provider}`);
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
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    appliedProviders.clear();
  });
}

export default registerProviderProxyExtension;
