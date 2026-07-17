import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockCtx, createMockPi, emitEvent, runCommand } from "../pip-common/testing.ts";
import { getPipSettingsRegistry } from "../pip-common/index.ts";
import {
  BUILTIN_MODEL_PATCHES,
  buildProviderModelPatch,
  loadUserModelPatches,
  parseUserModelPatches,
  registerProviderModelPatchesExtension,
  SETTINGS_ID,
  type ModelPatchSettings,
  type ProviderModelPatch,
} from "./index.ts";

const tempDirs: string[] = [];

function tempPath(name = "model-patches.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-patches-"));
  tempDirs.push(dir);
  return join(dir, name);
}

function model(provider: string, id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: `https://${provider}.example.test`,
    headers: { "X-Provider": provider },
    reasoning: true,
    thinkingLevelMap: { off: "none" },
    input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
    ...overrides,
  } as any;
}

function genericPatch(overrides: Partial<ProviderModelPatch> = {}): ProviderModelPatch {
  return {
    id: "target-next",
    label: "Target · Next",
    provider: "target",
    templateModel: "current",
    source: "user",
    models: [{ id: "next", metadataFrom: "source/next" }],
    ...overrides,
  };
}

function memorySettings(initial: Record<string, boolean> = {}): ModelPatchSettings & { values: Record<string, boolean> } {
  return {
    values: { ...initial },
    getEnabled(id) {
      return this.values[id] ?? false;
    },
    setEnabled(id, enabled) {
      this.values[id] = enabled;
    },
  };
}

function extensionHarness(options: {
  patches?: ProviderModelPatch[];
  enabled?: Record<string, boolean>;
  oauthAvailableIds?: string[];
  withOAuth?: boolean;
} = {}) {
  const patches = options.patches ?? [genericPatch()];
  const baseModels = [model("target", "current"), model("source", "next", { name: "Next Model" })];
  let currentModels = [...baseModels];
  const pi = createMockPi() as any;
  const settings = memorySettings(options.enabled);
  pi.registrations = [] as any[];
  pi.unregistrations = [] as string[];
  pi.selectedModels = [] as any[];

  const availableIds = new Set(options.oauthAvailableIds ?? ["current", "next"]);
  const oauth = {
    id: "target",
    name: "Target OAuth",
    login: async () => ({ access: "token", refresh: "refresh", expires: Date.now() + 60_000 }),
    refreshToken: async (credentials: any) => credentials,
    getApiKey: (credentials: any) => credentials.access,
    modifyModels: (models: any[]) => models.filter((entry) => entry.provider !== "target" || availableIds.has(entry.id)),
  };

  const ctx = createMockCtx();
  ctx.modelRegistry = {
    getAll: () => currentModels,
    find: (provider: string, id: string) => currentModels.find((entry) => entry.provider === provider && entry.id === id),
    getApiKeyForProvider: async () => "existing-auth-token",
    authStorage: { getOAuthProviders: () => (options.withOAuth === false ? [] : [oauth]) },
  };

  pi.registerProvider = (provider: string, config: any) => {
    pi.registrations.push({ provider, config });
    const replacement = config.models.map((entry: any) => ({ ...entry, provider, baseUrl: entry.baseUrl ?? config.baseUrl }));
    currentModels = [...currentModels.filter((entry) => entry.provider !== provider), ...replacement];
    if (config.oauth?.modifyModels) currentModels = config.oauth.modifyModels(currentModels, {});
  };
  pi.unregisterProvider = (provider: string) => {
    pi.unregistrations.push(provider);
    currentModels = [...baseModels];
  };
  pi.setModel = async (selected: any) => {
    pi.selectedModels.push(selected);
    ctx.model = selected;
    return true;
  };

  registerProviderModelPatchesExtension(pi, { patches, settings });
  return { pi, settings, ctx, getModels: () => currentModels };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("provider model patch definitions", () => {
  it("ships Copilot GPT-5.6 as a package-owned preset", () => {
    expect(BUILTIN_MODEL_PATCHES).toEqual([
      expect.objectContaining({
        id: "github-copilot-gpt-5-6",
        provider: "github-copilot",
        source: "builtin",
        models: expect.arrayContaining([
          expect.objectContaining({ id: "gpt-5.6-sol" }),
          expect.objectContaining({ id: "gpt-5.6-terra" }),
          expect.objectContaining({ id: "gpt-5.6-luna" }),
        ]),
      }),
    ]);
  });

  it("registers bundled presets in PIP settings as off by default", () => {
    const pi = createMockPi();
    registerProviderModelPatchesExtension(pi as any, { patches: BUILTIN_MODEL_PATCHES, settings: memorySettings() });
    expect(getPipSettingsRegistry(pi).get(`${SETTINGS_ID}.github-copilot-gpt-5-6`)).toBe(false);
  });

  it("pre-registers enabled bundled models before session_start so Pi can restore them", () => {
    const pi = createMockPi() as any;
    pi.registrations = [] as any[];
    pi.registerProvider = (provider: string, config: any) => pi.registrations.push({ provider, config });

    registerProviderModelPatchesExtension(pi, {
      patches: BUILTIN_MODEL_PATCHES,
      settings: memorySettings({ "github-copilot-gpt-5-6": true }),
    });

    expect(pi.registrations).toHaveLength(1);
    expect(pi.registrations[0]).toMatchObject({
      provider: "github-copilot",
      config: {
        models: expect.arrayContaining([
          expect.objectContaining({ id: "gpt-5.6-sol" }),
          expect.objectContaining({ id: "gpt-5.6-terra" }),
          expect.objectContaining({ id: "gpt-5.6-luna" }),
        ]),
      },
    });
  });

  it("avoids pi-ai provider subpaths that Pi's extension loader prefix-rewrites", () => {
    const source = readFileSync(join(import.meta.dirname, "presets.ts"), "utf8");
    expect(source).not.toMatch(/@earendil-works\/pi-ai\/providers\//);
  });

  it("uses bundled fallback metadata when Pi does not know the source models", () => {
    const models = [model("github-copilot", "gpt-5.5")];
    const result = buildProviderModelPatch(models, "github-copilot", BUILTIN_MODEL_PATCHES);

    expect(result.addedIds).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(result.models.find((entry) => entry.id === "gpt-5.6-sol")).toMatchObject({
      provider: "github-copilot",
      api: "openai-responses",
      baseUrl: "https://github-copilot.example.test",
      contextWindow: 272000,
    });
  });

  it("copies metadata generically while retaining target transport", () => {
    const models = [model("target", "current"), model("source", "next", { name: "Source Next", contextWindow: 999000 })];
    const result = buildProviderModelPatch(models, "target", [genericPatch()]);
    expect(result.models.find((entry) => entry.id === "next")).toMatchObject({
      provider: "target",
      name: "Source Next",
      contextWindow: 999000,
      baseUrl: "https://target.example.test",
      headers: { "X-Provider": "target" },
    });
  });

  it("rejects source and target API mismatches", () => {
    const models = [model("target", "current"), model("source", "next", { api: "anthropic-messages" })];
    expect(() => buildProviderModelPatch(models, "target", [genericPatch()])).toThrow(/uses anthropic-messages.*template current uses openai-responses/);
  });
});

describe("user-owned patch config", () => {
  it("does not create a missing user config", () => {
    const path = tempPath();
    expect(loadUserModelPatches(path)).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it("loads user patches without credentials", () => {
    const path = tempPath();
    writeFileSync(
      path,
      JSON.stringify({
        patches: [
          {
            id: "target-next",
            label: "Target Next",
            provider: "target",
            templateModel: "current",
            models: [{ id: "next", metadataFrom: "source/next" }],
          },
        ],
      }),
    );
    expect(loadUserModelPatches(path)).toEqual([genericPatch({ label: "Target Next" })]);
  });

  it("requires either source or explicit metadata", () => {
    expect(() =>
      parseUserModelPatches({ patches: [{ id: "broken", label: "Broken", provider: "target", templateModel: "current", models: [{ id: "next" }] }] }),
    ).toThrow(/needs metadataFrom or metadata/);
  });
});

describe("provider model patch extension", () => {
  it("defaults every patch to off without showing a footer status", async () => {
    const { pi, ctx } = extensionHarness();
    await emitEvent(pi, "session_start", {}, ctx);

    expect(pi.registrations).toHaveLength(0);
    expect(ctx.ui.statuses.get("provider-model-patches")).toBeUndefined();
  });

  it("restores an enabled patch on startup and reuses existing OAuth", async () => {
    const { pi, ctx, getModels } = extensionHarness({ enabled: { "target-next": true } });
    await emitEvent(pi, "session_start", {}, ctx);

    expect(pi.registrations).toHaveLength(1);
    expect(pi.registrations[0].config.oauth).toEqual(expect.objectContaining({ name: "Target OAuth" }));
    expect(pi.registrations[0].config).not.toHaveProperty("apiKey");
    expect(getModels().some((entry) => entry.provider === "target" && entry.id === "next")).toBe(true);
    expect(ctx.ui.statuses.get("provider-model-patches")).toBe("patches: target");
  });

  it("reuses an existing API key in memory when the provider has no OAuth", async () => {
    const { pi, ctx } = extensionHarness({ enabled: { "target-next": true }, withOAuth: false });
    await emitEvent(pi, "session_start", {}, ctx);

    expect(pi.registrations[0].config.apiKey).toBe("existing-auth-token");
  });

  it("keeps policy-filtered models unavailable and restores the default catalog", async () => {
    const { pi, ctx } = extensionHarness({ enabled: { "target-next": true }, oauthAvailableIds: ["current"] });
    await emitEvent(pi, "session_start", {}, ctx);

    expect(pi.unregistrations).toEqual(["target"]);
    expect(ctx.ui.notifications.some((entry: any) => String(entry.message).includes("Model patch unavailable"))).toBe(true);
    expect(ctx.ui.statuses.get("provider-model-patches")).toBe("patches: default");
  });

  it("toggles persistently and switches away before leaving a removed model", async () => {
    const { pi, settings, ctx } = extensionHarness();
    await runCommand(pi, "model-patch", "on target", ctx);
    expect(settings.values["target-next"]).toBe(true);

    ctx.model = model("target", "next");
    await runCommand(pi, "model-patch", "off target", ctx);

    expect(settings.values["target-next"]).toBe(false);
    expect(pi.unregistrations).toEqual(["target"]);
    expect(pi.selectedModels[0]?.id).toBe("current");
    expect(ctx.ui.statuses.get("provider-model-patches")).toBeUndefined();
  });
});
