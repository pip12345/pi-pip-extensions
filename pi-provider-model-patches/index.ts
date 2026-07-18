import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPipSettingsRegistry, registerProviderOverrideContributor, registerSettingsSection, setting, type SettingsRegistry } from "../pip-common/index.ts";
import { loadUserModelPatches, mergeModelPatches, USER_PATCHES_PATH } from "./config.ts";
import { BUILTIN_MODEL_PATCHES, getBuiltinPatchProviderCatalog } from "./presets.ts";
import type { ModelPatchMetadata, PatchBuildResult, PatchModelDefinition, ProviderModelPatch } from "./types.ts";

export { loadUserModelPatches, mergeModelPatches, parseUserModelPatches, USER_PATCHES_PATH } from "./config.ts";
export { BUILTIN_MODEL_PATCHES } from "./presets.ts";
export type { ModelPatchMetadata, PatchModelDefinition, ProviderModelPatch, UserModelPatchesFile } from "./types.ts";

export const SETTINGS_ID = "provider-model-patches";
const STATUS_KEY = "provider-model-patches";

export interface ModelPatchSettings {
  getEnabled(patchId: string): boolean;
  setEnabled(patchId: string, enabled: boolean): void;
}

export interface ProviderModelPatchesOptions {
  patches?: ProviderModelPatch[];
  userConfigPath?: string;
  settings?: ModelPatchSettings;
  builtinCatalogLoader?: typeof getBuiltinPatchProviderCatalog;
}

interface ReconcileResult {
  provider: string;
  addedIds: string[];
  unavailableIds: string[];
}

function registerPatchSettings(pi: ExtensionAPI, patches: ProviderModelPatch[]): void {
  registerSettingsSection(pi, {
    id: SETTINGS_ID,
    title: "Provider Model Patches",
    description: "Opt-in model catalog patches. Each target provider uses its existing Pi authentication and transport.",
    order: 35,
    settings: Object.fromEntries(
      patches.map((patch, index) => [
        patch.id,
        setting.boolean({
          label: patch.label,
          default: false,
          order: index + 1,
          requiresReload: true,
          description: `Patch ${patch.provider}. Applies after /reload or the next launch; /model-patch applies immediately.`,
        }),
      ]),
    ),
  });
}

function defaultSettings(registry: SettingsRegistry): ModelPatchSettings {
  return {
    getEnabled(patchId) {
      try {
        return registry.get<boolean>(`${SETTINGS_ID}.${patchId}`);
      } catch {
        return false;
      }
    },
    setEnabled(patchId, enabled) {
      registry.set(`${SETTINGS_ID}.${patchId}`, enabled);
    },
  };
}

function splitModelReference(reference: string): { provider: string; id: string } {
  const slash = reference.indexOf("/");
  if (slash <= 0 || slash === reference.length - 1) throw new Error(`Invalid metadataFrom reference: ${reference}; expected provider/model-id`);
  return { provider: reference.slice(0, slash), id: reference.slice(slash + 1) };
}

function finitePositive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`);
  return value;
}

function resolveMetadata(definition: PatchModelDefinition, models: Model<Api>[], patchId: string): ModelPatchMetadata {
  let source: Model<Api> | undefined;
  if (definition.metadataFrom) {
    const reference = splitModelReference(definition.metadataFrom);
    source = models.find((model) => model.provider === reference.provider && model.id === reference.id);
  }

  const override = definition.metadata ?? {};
  const metadata = {
    name: override.name ?? source?.name,
    api: override.api ?? source?.api,
    reasoning: override.reasoning ?? source?.reasoning,
    thinkingLevelMap: override.thinkingLevelMap ?? (source?.thinkingLevelMap as Record<string, string | null> | undefined),
    input: override.input ?? source?.input,
    cost: override.cost ?? source?.cost,
    contextWindow: override.contextWindow ?? source?.contextWindow,
    maxTokens: override.maxTokens ?? source?.maxTokens,
    compat: override.compat,
  };

  const label = `Patch ${patchId} model ${definition.id}`;
  if (typeof metadata.name !== "string" || !metadata.name) throw new Error(`${label} is missing metadata.name`);
  if (typeof metadata.api !== "string" || !metadata.api) throw new Error(`${label} is missing metadata.api`);
  if (typeof metadata.reasoning !== "boolean") throw new Error(`${label} is missing metadata.reasoning`);
  if (!Array.isArray(metadata.input) || !metadata.input.length || metadata.input.some((input) => input !== "text" && input !== "image")) {
    throw new Error(`${label} has invalid metadata.input`);
  }
  if (!metadata.cost || typeof metadata.cost !== "object") throw new Error(`${label} is missing metadata.cost`);
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const value = metadata.cost[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} has invalid metadata.cost.${key}`);
  }

  return {
    name: metadata.name,
    api: metadata.api,
    reasoning: metadata.reasoning,
    thinkingLevelMap: metadata.thinkingLevelMap,
    input: metadata.input as ("text" | "image")[],
    cost: metadata.cost,
    contextWindow: finitePositive(metadata.contextWindow, `${label} metadata.contextWindow`),
    maxTokens: finitePositive(metadata.maxTokens, `${label} metadata.maxTokens`),
    compat: metadata.compat,
  };
}

function findTemplate(providerModels: Model<Api>[], id: string, patchId: string): Model<Api> {
  const template = providerModels.find((model) => model.id === id);
  if (!template) throw new Error(`Patch ${patchId} cannot find target transport template ${id}`);
  return template;
}

export function buildProviderModelPatch(models: Model<Api>[], provider: string, patches: ProviderModelPatch[]): PatchBuildResult {
  const providerModels = models.filter((model) => model.provider === provider);
  if (!providerModels.length) throw new Error(`Target provider ${provider} has no models in Pi`);

  const patched = [...providerModels];
  const existingIds = new Set(providerModels.map((model) => model.id));
  const addedIds: string[] = [];
  const templates = new Map<string, Model<Api>>();

  for (const patch of patches) {
    if (patch.provider !== provider) throw new Error(`Patch ${patch.id} targets ${patch.provider}, not ${provider}`);
    for (const definition of patch.models) {
      if (existingIds.has(definition.id)) continue;
      const templateId = definition.templateModel ?? patch.templateModel;
      const template = findTemplate(providerModels, templateId, patch.id);
      const metadata = resolveMetadata(definition, models, patch.id);
      if (metadata.api !== template.api) {
        throw new Error(`Patch ${patch.id} model ${definition.id} uses ${metadata.api}, but target template ${template.id} uses ${template.api}`);
      }

      patched.push({
        id: definition.id,
        name: metadata.name,
        api: metadata.api,
        provider,
        baseUrl: template.baseUrl,
        headers: template.headers,
        compat: metadata.compat ?? template.compat,
        reasoning: metadata.reasoning,
        thinkingLevelMap: metadata.thinkingLevelMap as Model<Api>["thinkingLevelMap"],
        input: metadata.input,
        cost: metadata.cost,
        contextWindow: metadata.contextWindow,
        maxTokens: metadata.maxTokens,
      });
      templates.set(template.id, template);
      existingIds.add(definition.id);
      addedIds.push(definition.id);
    }
  }

  return { provider, models: patched, addedIds, templates: [...templates.values()] };
}

function providerModelConfig(model: Model<Api>) {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: model.headers,
    compat: model.compat,
  };
}

function show(ctx: any, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx?.ui?.notify) ctx.ui.notify(message, level);
  else console.log(message);
}

function patchMatches(patch: ProviderModelPatch, selector: string): boolean {
  return patch.id === selector || patch.provider === selector;
}

export async function registerProviderModelPatchesExtension(pi: ExtensionAPI, options: ProviderModelPatchesOptions = {}): Promise<void> {
  let configError: string | undefined;
  let patches: ProviderModelPatch[];
  try {
    patches = options.patches ?? mergeModelPatches(BUILTIN_MODEL_PATCHES, loadUserModelPatches(options.userConfigPath ?? USER_PATCHES_PATH));
  } catch (error) {
    patches = [...BUILTIN_MODEL_PATCHES];
    configError = error instanceof Error ? error.message : String(error);
  }

  registerPatchSettings(pi, patches);
  const settings = options.settings ?? defaultSettings(getPipSettingsRegistry(pi));
  const appliedIds = new Map<string, Set<string>>();
  const appliedConfigs = new Map<string, Record<string, any>>();
  const baseModels = new Map<string, Model<Api>[]>();
  const providerOverrides = registerProviderOverrideContributor(pi, { id: "pi-provider-model-patches", role: "catalog" });

  // Pi resolves the initial/session model after extension loading but before session_start.
  // Pre-register enabled package-owned catalogs here so saved patched models can be restored.
  for (const provider of new Set(patches.filter((patch) => patch.source === "builtin" && settings.getEnabled(patch.id)).map((patch) => patch.provider))) {
    const catalog = await (options.builtinCatalogLoader ?? getBuiltinPatchProviderCatalog)(provider);
    if (!catalog) continue;

    const enabled = patches.filter((patch) => patch.source === "builtin" && patch.provider === provider && settings.getEnabled(patch.id));
    const result = buildProviderModelPatch(catalog.models, provider, enabled);
    if (!result.addedIds.length) continue;

    const firstTemplate = result.templates[0];
    if (!firstTemplate) throw new Error(`Patch for ${provider} produced no target transport template`);
    baseModels.set(provider, catalog.models.filter((model) => model.provider === provider));
    // Catalog-only overrides inherit the built-in provider's auth, policy
    // filtering, and streaming implementation from Pi's provider composer.
    const providerConfig = {
      baseUrl: firstTemplate.baseUrl,
      api: firstTemplate.api,
      models: result.models.map(providerModelConfig) as any,
    };
    providerOverrides.set(provider, providerConfig);
    appliedConfigs.set(provider, providerConfig);
    appliedIds.set(provider, new Set(result.addedIds));
  }

  const enabledForProvider = (provider: string) => patches.filter((patch) => patch.provider === provider && settings.getEnabled(patch.id));
  const patchedProviders = () => [...appliedIds.entries()].filter(([, ids]) => ids.size > 0).map(([provider]) => provider).sort();

  const updateStatus = (ctx: any) => {
    const providers = patchedProviders();
    const anyEnabled = patches.some((patch) => settings.getEnabled(patch.id));
    ctx.ui?.setStatus?.(STATUS_KEY, providers.length ? `patches: ${providers.join(",")}` : anyEnabled ? "patches: default" : undefined);
  };

  const switchFromRemovedModel = async (ctx: any, provider: string, removedIds: Set<string>) => {
    if (ctx.model?.provider !== provider || !removedIds.has(ctx.model.id)) return;
    const fallback = ctx.modelRegistry.getAll().find((model: Model<Api>) => model.provider === provider);
    if (fallback) await pi.setModel(fallback);
  };

  const reconcileProvider = async (ctx: any, provider: string): Promise<ReconcileResult> => {
    const previouslyAdded = appliedIds.get(provider) ?? new Set<string>();
    const previouslyAvailable = new Set([...previouslyAdded].filter((id) => Boolean(ctx.modelRegistry.find(provider, id))));
    const enabled = enabledForProvider(provider);

    if (!enabled.length) {
      if (appliedIds.has(provider)) {
        providerOverrides.remove(provider);
        appliedIds.delete(provider);
        appliedConfigs.delete(provider);
        await switchFromRemovedModel(ctx, provider, previouslyAdded);
      }
      return { provider, addedIds: [], unavailableIds: [] };
    }

    if (!baseModels.has(provider)) {
      baseModels.set(
        provider,
        ctx.modelRegistry.getAll().filter((model: Model<Api>) => model.provider === provider),
      );
    }
    const cleanCatalog = [
      ...ctx.modelRegistry.getAll().filter((model: Model<Api>) => model.provider !== provider),
      ...(baseModels.get(provider) ?? []),
    ];
    // Build before disturbing an already-working registration. Pi composes
    // this catalog with the built-in provider's existing auth and transport.
    const result = buildProviderModelPatch(cleanCatalog, provider, enabled);
    const firstTemplate = result.templates[0];
    if (result.addedIds.length && !firstTemplate) throw new Error(`Patch for ${provider} produced no target transport template`);

    if (!result.addedIds.length) {
      if (appliedIds.has(provider)) providerOverrides.remove(provider);
      appliedIds.delete(provider);
      appliedConfigs.delete(provider);
      await switchFromRemovedModel(ctx, provider, previouslyAdded);
      return { provider, addedIds: [], unavailableIds: [] };
    }

    const previousConfig = appliedConfigs.get(provider);
    const nextConfig = {
      baseUrl: firstTemplate!.baseUrl,
      api: firstTemplate!.api,
      models: result.models.map(providerModelConfig) as any,
    };
    // Replacing the same contribution lets the coordinator restore its prior
    // registration if Pi rejects the new catalog.
    providerOverrides.set(provider, nextConfig);

    const availableAdded = result.addedIds.filter((id) => Boolean(ctx.modelRegistry.find(provider, id)));
    const unavailableIds = result.addedIds.filter((id) => !availableAdded.includes(id));
    if (!availableAdded.length) {
      if (previousConfig && previouslyAvailable.size) {
        providerOverrides.set(provider, previousConfig);
        appliedIds.set(provider, previouslyAvailable);
      } else {
        providerOverrides.remove(provider);
        appliedIds.delete(provider);
        appliedConfigs.delete(provider);
      }
      return { provider, addedIds: [...previouslyAvailable], unavailableIds };
    }
    appliedConfigs.set(provider, nextConfig);
    appliedIds.set(provider, new Set(availableAdded));
    const removedIds = new Set([...previouslyAdded].filter((id) => !availableAdded.includes(id)));
    await switchFromRemovedModel(ctx, provider, removedIds);
    return { provider, addedIds: availableAdded, unavailableIds };
  };

  const statusText = () => {
    const lines = patches.map((patch) => {
      const enabled = settings.getEnabled(patch.id);
      const active = [...(appliedIds.get(patch.provider) ?? [])].some((id) => patch.models.some((model) => model.id === id));
      const state = active ? "patched" : enabled ? "enabled · native/unavailable" : "off · default";
      return `${patch.id}: ${state} (${patch.provider}, ${patch.source})`;
    });
    lines.push(`User config: ${options.userConfigPath ?? USER_PATCHES_PATH}${configError ? `\nConfig error: ${configError}` : ""}`);
    return lines.join("\n");
  };

  pi.registerCommand("model-patch", {
    description: "Manage persistent provider model catalog patches",
    handler: async (args: string, ctx: any) => {
      const [commandRaw, selectorRaw, ...extra] = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const command = commandRaw?.toLowerCase() || "status";
      const selector = selectorRaw?.toLowerCase();
      try {
        if (command === "status") {
          show(ctx, statusText(), configError ? "warning" : "info");
          return;
        }
        if (command === "reload") {
          await ctx.reload();
          return;
        }
        if ((command !== "on" && command !== "enable" && command !== "off" && command !== "disable") || !selector || extra.length) {
          throw new Error("Usage: /model-patch status | on <patch-or-provider> | off <patch-or-provider> | reload");
        }

        const selected = patches.filter((patch) => patchMatches(patch, selector));
        if (!selected.length) throw new Error(`Unknown model patch or provider: ${selector}`);
        const enabled = command === "on" || command === "enable";
        for (const patch of selected) settings.setEnabled(patch.id, enabled);

        const results: ReconcileResult[] = [];
        for (const provider of [...new Set(selected.map((patch) => patch.provider))]) results.push(await reconcileProvider(ctx, provider));
        updateStatus(ctx);
        const added = results.flatMap((result) => result.addedIds.map((id) => `${result.provider}/${id}`));
        const unavailable = results.flatMap((result) => result.unavailableIds.map((id) => `${result.provider}/${id}`));
        const summary = enabled
          ? added.length
            ? `Enabled model patches: ${added.join(", ")}`
            : "Patch enabled, but the configured models are already native or unavailable to this account."
          : `Disabled model patches for ${[...new Set(selected.map((patch) => patch.provider))].join(", ")}. Default provider catalog restored.`;
        show(ctx, unavailable.length ? `${summary}\nUnavailable after provider policy filtering: ${unavailable.join(", ")}` : summary, unavailable.length ? "warning" : "info");
      } catch (error) {
        updateStatus(ctx);
        show(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    if (configError) show(ctx, `User model patches were not loaded: ${configError}`, "warning");
    for (const provider of [...new Set(patches.filter((patch) => settings.getEnabled(patch.id)).map((patch) => patch.provider))]) {
      try {
        const result = await reconcileProvider(ctx, provider);
        if (result.unavailableIds.length) show(ctx, `Model patch unavailable for ${provider}: ${result.unavailableIds.join(", ")}`, "warning");
      } catch (error) {
        show(ctx, `Model patch could not start for ${provider}: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    providerOverrides.dispose();
    appliedIds.clear();
    appliedConfigs.clear();
  });
}

export default registerProviderModelPatchesExtension;
