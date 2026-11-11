import { describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { createModels, InMemoryModelsStore, normalizeContext, type Message } from "@earendil-works/pi-ai";
import { authenticated, baseOptions, executable, loadSDK, loggedIn, probe, requireExecutable, verifyVersion } from "./src/sdk.ts";
import { ClaudeRuntime } from "./src/runtime.ts";
import { createClaudeProvider, modelDefinition } from "./src/provider.ts";
import { createMockCtx, createMockPi, emitEvent, runCommand } from "../pip-common/testing.ts";
import extension from "./index.ts";

const fixture = resolve(import.meta.dirname, "fixtures/claude.js");

describe("Claude Agent setup", () => {
  it("uses only an explicit executable or PATH, never the SDK's bundled CLI", () => {
    expect(executable({ PATH: "" })).toBeUndefined();
    expect(() => requireExecutable({ PATH: "" })).toThrow("Claude Code is not installed");
    const directory = mkdtempSync(join(tmpdir(), "pi-claude-path-"));
    try {
      const path = join(directory, process.platform === "win32" ? "claude.exe" : "claude");
      writeFileSync(path, "#!/bin/sh\nexit 0\n"); chmodSync(path, 0o755);
      expect(executable({ PATH: directory })).toBe(path);
      expect(executable({ PATH: directory, PI_CLAUDE_PATH: join(directory, "missing") })).toBeUndefined();
      expect(executable({ PATH: "", PI_CLAUDE_PATH: path })).toBe(path);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("checks CLI auth only when requested, without scheduling background polls", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-claude-auth-"));
    const log = join(directory, "calls");
    const interval = vi.spyOn(globalThis, "setInterval");
    try {
      expect(await authenticated(fixture, directory, { ...process.env, CLAUDE_FIXTURE_AUTH_LOG: log }, new AbortController().signal)).toBe(true);
      expect(readFileSync(log, "utf8")).toBe("status\n");
      await new Promise((done) => setTimeout(done, 50));
      expect(readFileSync(log, "utf8")).toBe("status\n");
      expect(interval).not.toHaveBeenCalled();
    } finally { interval.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("distinguishes logged-out status from CLI failures and honors cancellation", async () => {
    const signal = new AbortController().signal;
    expect(await authenticated(fixture, process.cwd(), { ...process.env, CLAUDE_FIXTURE_LOGGED_OUT: "1" }, signal)).toBe(false);
    await expect(authenticated(fixture, process.cwd(), { ...process.env, CLAUDE_FIXTURE_AUTH_FAIL: "1" }, signal)).rejects.toThrow("Could not check Claude Code authentication");
    const cancelled = new AbortController(); cancelled.abort(new Error("cancelled"));
    await expect(authenticated(fixture, process.cwd(), process.env, cancelled.signal)).rejects.toThrow("cancelled");
  });

  it("hides cached models after logout and exposes them after login without a polling loop", async () => {
    const store = new InMemoryModelsStore();
    await store.write("claude-agent", { models: [modelDefinition({ value: "sonnet", displayName: "Sonnet", description: "" }, false)] });
    const runtime = new ClaudeRuntime();
    const models = createModels({ modelsStore: store, authContext: { env: async (name) => name === "PI_CLAUDE_PATH" ? fixture : undefined, fileExists: async () => true } });
    models.setProvider(createClaudeProvider(runtime, () => process.cwd()));
    try {
      await models.refresh({ allowNetwork: false });
      expect(models.getModels("claude-agent")).toHaveLength(1);
      expect(await models.getAvailable("claude-agent")).toHaveLength(1);
      vi.stubEnv("CLAUDE_FIXTURE_LOGGED_OUT", "1");
      expect(await models.getAvailable("claude-agent")).toEqual([]);
      expect(models.getModels("claude-agent")).toHaveLength(1);
      vi.stubEnv("CLAUDE_FIXTURE_LOGGED_OUT", undefined);
      expect(await models.getAvailable("claude-agent")).toHaveLength(1);
    } finally { vi.unstubAllEnvs(); await runtime.close(); }
  });

  it("hides cached models when the configured executable is missing", async () => {
    const store = new InMemoryModelsStore();
    await store.write("claude-agent", { models: [modelDefinition({ value: "sonnet", displayName: "Sonnet", description: "" }, false)] });
    const runtime = new ClaudeRuntime();
    const models = createModels({ modelsStore: store, authContext: { env: async (name) => name === "PI_CLAUDE_PATH" ? join(import.meta.dirname, "missing-claude") : undefined, fileExists: async () => false } });
    models.setProvider(createClaudeProvider(runtime, () => process.cwd()));
    try {
      await models.refresh({ allowNetwork: false });
      expect(models.getModels("claude-agent")).toHaveLength(1);
      expect(await models.getAvailable("claude-agent")).toEqual([]);
    } finally { await runtime.close(); }
  });

  it("rejects missing and older CLI versions", () => {
    expect(() => verifyVersion("2.1.247")).toThrow("2.1.248");
    expect(() => verifyVersion(undefined)).toThrow("unknown version");
    expect(() => verifyVersion("2.1.248")).not.toThrow();
    expect(() => verifyVersion("2.1.301-preview")).not.toThrow();
  });

  it("recognizes subscription metadata when the CLI does not report tokenSource", () => {
    expect(loggedIn({ apiProvider: "firstParty", subscriptionType: "Claude Max" })).toBe(true);
    expect(loggedIn({ apiProvider: "firstParty", tokenSource: "none" })).toBe(false);
    expect(loggedIn({ apiProvider: "bedrock" })).toBe(true);
  });

  it("uses discovered effort capabilities and does not advertise thinking-off for mandatory-thinking models", () => {
    const model = modelDefinition({ value: "sonnet", displayName: "Sonnet", description: "", supportsThinkingOff: false, supportedEffortLevels: ["low", "high", "xhigh"] }, false);
    expect(model.thinkingLevelMap).toEqual({ off: null, minimal: "low", low: "low", medium: null, high: "high", xhigh: "xhigh", max: null });
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("registers a separate ambient-auth provider without opening a process at extension load", async () => {
    const pi = createMockPi();
    extension(pi as any);
    expect(pi.providerRegistrations.map((provider) => provider.id)).toEqual(["claude-agent"]);
    expect(pi.providerRegistrations[0].auth.oauth).toBeUndefined();
    expect(pi.providerRegistrations[0].getModels()).toEqual([]);
    await emitEvent(pi, "session_shutdown");
  });

  it.each(["", "status"])("status command directs users to /model without refreshing catalogs (%j)", async (args) => {
    const pi = createMockPi(); extension(pi as any);
    const ctx = createMockCtx();
    ctx.modelRegistry = { refresh: vi.fn() };
    await runCommand(pi, "claude-agent", args, ctx);
    expect(ctx.ui.notifications).toHaveLength(1);
    expect(ctx.ui.notifications[0].message).toContain("with /model.");
    expect(ctx.ui.notifications[0].message).not.toContain("/claude-agent refresh");
    expect(ctx.modelRegistry.refresh).not.toHaveBeenCalled();
    await emitEvent(pi, "session_shutdown");
  });

  it("rejects the removed refresh subcommand without refreshing catalogs", async () => {
    const pi = createMockPi(); extension(pi as any);
    const ctx = createMockCtx();
    ctx.modelRegistry = { refresh: vi.fn() };
    await runCommand(pi, "claude-agent", "refresh", ctx);
    expect(ctx.ui.notifications).toEqual([{ message: "Usage: /claude-agent [status]", level: "error" }]);
    expect(ctx.modelRegistry.refresh).not.toHaveBeenCalled();
    await emitEvent(pi, "session_shutdown");
  });
});

describe("real Anthropic SDK subprocess contract (no network or login)", () => {
  it("discovers models and context sizes through the actual SDK", async () => {
    const sdk = await loadSDK();
    const found = await probe(sdk, baseOptions(fixture, process.cwd()));
    expect(found.account.subscriptionType).toBe("Claude Max");
    expect(found.models).toMatchObject([{ value: "sonnet", contextWindow: 1_000_000 }]);
    expect(found.models[0]!.supportsThinkingOff).toBe(false);
  }, 15_000);

  it("passes real SDK MCP calls through Pi's tool boundary and continues the same subprocess", async () => {
    const runtime = new ClaudeRuntime({ executable: () => fixture });
    try {
      const model = modelDefinition({ value: "sonnet", displayName: "Sonnet", description: "", supportedEffortLevels: ["high"] }, false);
      const messages: Message[] = [{ role: "system", content: "Pi instructions", toolsAdded: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }], timestamp: 0 }, { role: "user", content: "read example", timestamp: 1 }];
      const options = { sessionId: "native-sdk", reasoning: "high" as const };
      const first = await runtime.stream(model, normalizeContext({ messages }), options).result();
      expect(first.stopReason, first.errorMessage).toBe("toolUse");
      expect(first.content).toContainEqual({ type: "toolCall", id: "native-call", name: "read", arguments: { path: "example" } });
      messages.push(first, { role: "toolResult", toolCallId: "native-call", toolName: "read", content: [{ type: "text", text: "approved by Pi" }], isError: false, timestamp: 2 });
      const second = await runtime.stream(model, normalizeContext({ messages }), options).result();
      expect(second.stopReason, second.errorMessage).toBe("stop");
      expect(second.content).toEqual([{ type: "text", text: "Pi returned: approved by Pi" }]);
      messages.push(second, { role: "user", content: "next turn", timestamp: 3 });
      const third = await runtime.stream(model, normalizeContext({ messages }), options).result();
      expect(third.content).toEqual([{ type: "text", text: "native SDK response 🦊" }]);
    } finally { await runtime.close(); }
  }, 15_000);

  it("loads and streams through Pi's extension loader, including the lazy SDK import", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-claude-load-"));
    vi.stubEnv("PI_CLAUDE_PATH", fixture);
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, additionalExtensionPaths: [import.meta.dirname], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    try {
      await loader.reload();
      const loaded = loader.getExtensions();
      expect(loaded.errors).toEqual([]);
      const provider = loaded.runtime.pendingNativeProviderRegistrations.find((entry) => entry.provider.id === "claude-agent")!.provider;
      const models = createModels(); models.setProvider(provider);
      expect((await models.refresh()).errors.size).toBe(0);
      const model = models.getModel("claude-agent", "sonnet")!;
      const answer = await models.completeSimple(model, { systemPrompt: "Pi instructions", messages: [{ role: "user", content: "hello", timestamp: 1 }] });
      expect(answer.stopReason, answer.errorMessage).toBe("stop");
      expect(answer.content).toEqual([{ type: "text", text: "native SDK response 🦊" }]);
    } finally {
      for (const loaded of loader.getExtensions().extensions) for (const handler of loaded.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, {} as any);
      vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("refuses an old or logged-out CLI before sending a model prompt", async () => {
    const sdk = await loadSDK();
    await expect(probe(sdk, baseOptions(fixture, process.cwd(), { ...process.env, CLAUDE_FIXTURE_VERSION: "2.1.247" }))).rejects.toThrow("unsupported");
    await expect(probe(sdk, baseOptions(fixture, process.cwd(), { ...process.env, CLAUDE_FIXTURE_LOGGED_OUT: "1" }))).rejects.toThrow("not logged in");
  }, 15_000);

  it("publishes a discovered model catalog using Pi's real provider registry", async () => {
    const runtime = new ClaudeRuntime();
    const models = createModels({ authContext: { env: async (name) => name === "PI_CLAUDE_PATH" ? fixture : undefined, fileExists: async () => true } });
    const provider = createClaudeProvider(runtime, () => process.cwd());
    models.setProvider(provider);
    try {
      const refreshed = await models.refresh();
      expect([...refreshed.errors.values()].map((error) => error.message)).toEqual([]);
      expect(models.getModel("claude-agent", "sonnet")).toMatchObject({ contextWindow: 1_000_000, thinkingLevelMap: { off: null } });
    } finally { await runtime.close(); }
  }, 15_000);
});
