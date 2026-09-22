import { describe, expect, it } from "vitest";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createMockCtx, createMockPi, emitEvent, runCommand } from "../pip-common/testing.ts";
import registerCodexFastExtension, {
  FAST_SERVICE_TIER,
  FAST_STATE_ENTRY,
  LONG_CONTEXT_WINDOW,
  applyFastServiceTier,
  applyLongContextWindow,
  extendOpenAICodexModels,
  isFastCapableCodexModel,
  openAICodexModels,
  restoreFastState,
} from "./index.ts";

const codexModel = {
  id: "gpt-5.6-sol",
  provider: "openai-codex",
  api: "openai-codex-responses",
  contextWindow: 272_000,
};

function codexPayload(model = codexModel.id) {
  return { model, store: false, stream: true, input: [], instructions: "test" };
}

function stateEntry(enabled: boolean) {
  return { type: "custom", customType: FAST_STATE_ENTRY, data: { enabled } };
}

function createCodexPi() {
  return createMockPi();
}

function getCodexModel(id: string) {
  const model = openAICodexModels().find((model) => model.id === id);
  expect(model, `pi-codex catalog must include ${id}`).toBeDefined();
  return structuredClone(model!);
}

describe("Codex model catalog", () => {
  it("adds GPT-6 Sol and Luna to Pi's native provider catalog", () => {
    const nativeModels = builtinProviders().find((provider) => provider.id === "openai-codex")!.getModels();
    const models = openAICodexModels();

    expect(models.map((model) => model.id)).toEqual([...nativeModels.map((model) => model.id), "gpt-6-sol", "gpt-6-luna"]);
    expect(models.find((model) => model.id === "gpt-6-sol")).toMatchObject({
      name: "GPT-6 Sol",
      contextWindow: 272_000,
      maxTokens: 128_000,
      input: ["text", "image"],
      cost: {
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite: 2.5,
        tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
      },
    });
    expect(models.find((model) => model.id === "gpt-6-luna")).toMatchObject({
      name: "GPT-6 Luna",
      contextWindow: 272_000,
      maxTokens: 128_000,
      input: ["text", "image"],
      cost: {
        input: 0.1,
        output: 0.5,
        cacheRead: 0.01,
        cacheWrite: 0.125,
        tiers: [{ inputTokensAbove: 272_000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }],
      },
    });
  });

  it("preserves native definitions when Pi adds either model", () => {
    const native = { ...getCodexModel("gpt-6-sol"), name: "Native GPT-6 Sol" };
    const extended = extendOpenAICodexModels([native]);

    expect(extended.filter((model) => model.id === "gpt-6-sol")).toEqual([native]);
    expect(extended.some((model) => model.id === "gpt-6-luna")).toBe(true);
  });

  it("registers the extended catalog through the shared provider coordinator", () => {
    const pi = createCodexPi();
    registerCodexFastExtension(pi as any);

    expect(pi.providerRegistrations).toHaveLength(1);
    expect(pi.providerRegistrations[0]).toMatchObject({ name: "openai-codex", config: { models: expect.any(Array) } });
    expect(pi.providerRegistrations[0].config.models.map((model: any) => model.id)).toEqual(expect.arrayContaining(["gpt-6-sol", "gpt-6-luna"]));
  });
});

describe("Codex long context catalog", () => {
  it("expands GPT-5.6 and GPT-6 long-context variants without changing other models or providers", () => {
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
      expect(applyLongContextWindow({ id, provider: "openai-codex", contextWindow: 272_000 }).contextWindow).toBe(LONG_CONTEXT_WINDOW);
    }
    const older = { id: "gpt-5.5", provider: "openai-codex", contextWindow: 272_000 };
    const directOpenAI = { id: "gpt-5.6-sol", provider: "openai", contextWindow: 272_000 };
    expect(applyLongContextWindow(older)).toBe(older);
    expect(applyLongContextWindow(directOpenAI)).toBe(directOpenAI);
  });

  it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"])("sets only the context window when %s becomes active", async (id) => {
    const pi = createCodexPi();
    registerCodexFastExtension(pi as any);
    const catalogModel = getCodexModel(id);
    expect(catalogModel.contextWindow).toBe(272_000);
    const expectedModel = { ...catalogModel, contextWindow: LONG_CONTEXT_WINDOW };
    const activeModel = structuredClone(catalogModel);
    const ctx = createMockCtx({ model: activeModel });

    await emitEvent(pi, "session_start", {}, ctx);
    expect(activeModel).toEqual(expectedModel);
    expect(applyLongContextWindow(activeModel)).toBe(activeModel);

    const selectedModel = structuredClone(catalogModel);
    await emitEvent(pi, "model_select", { model: selectedModel }, ctx);
    expect(selectedModel).toEqual(expectedModel);
  });
});

describe("Codex Fast capability", () => {
  it("accepts documented Codex model families without hardcoding catalog entries", () => {
    expect(isFastCapableCodexModel(codexModel)).toBe(true);
    expect(isFastCapableCodexModel({ ...codexModel, id: "gpt-5.4-new-catalog-variant" })).toBe(true);
    expect(isFastCapableCodexModel({ ...codexModel, id: "gpt-6-astra" })).toBe(true);
    expect(isFastCapableCodexModel({ ...codexModel, id: "gpt-6-sol" })).toBe(true);
    expect(isFastCapableCodexModel({ ...codexModel, id: "gpt-6-luna" })).toBe(true);
    expect(isFastCapableCodexModel({ ...codexModel, id: "gpt-6-unknown" })).toBe(false);
    expect(isFastCapableCodexModel({ ...codexModel, id: "gpt-5.3-codex-spark" })).toBe(false);
    expect(isFastCapableCodexModel({ ...codexModel, id: "gpt-5.2-codex" })).toBe(false);
  });

  it("prefers explicit catalog service-tier capability metadata", () => {
    expect(isFastCapableCodexModel({ ...codexModel, id: "gpt-6", serviceTiers: [{ id: "priority", name: "Fast" }] })).toBe(true);
    expect(isFastCapableCodexModel({ ...codexModel, service_tiers: [] })).toBe(false);
    expect(isFastCapableCodexModel({ ...codexModel, serviceTiers: [{ id: "flex", name: "Slow" }] })).toBe(false);
  });

  it("requires the exact built-in Codex provider and API", () => {
    expect(isFastCapableCodexModel({ ...codexModel, provider: "openai" })).toBe(false);
    expect(isFastCapableCodexModel({ ...codexModel, api: "openai-responses" })).toBe(false);
  });
});

describe("Codex request patching", () => {
  it("adds priority to a recognized request for the active model", () => {
    const payload = codexPayload();
    expect(applyFastServiceTier(payload, codexModel)).toEqual({ ...payload, service_tier: FAST_SERVICE_TIER });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("leaves mismatched, malformed, unsupported, and non-Codex requests untouched", () => {
    const payload = codexPayload();
    const unsupported = { ...codexModel, id: "gpt-5.3-codex-spark" };
    for (const [candidate, model] of [
      [{ ...payload, model: "different" }, codexModel],
      [{ ...payload, stream: false }, codexModel],
      [{ ...payload, store: true }, codexModel],
      [{ ...payload, input: "not-an-array" }, codexModel],
      [payload, unsupported],
      [payload, { ...codexModel, provider: "openai" }],
    ] as const) {
      expect(applyFastServiceTier(candidate, model)).toBe(candidate);
    }
  });

  it("does not override a tier already supplied by Pi or another extension", () => {
    const flexPayload = { ...codexPayload(), service_tier: "flex" };
    const priorityPayload = { ...codexPayload(), service_tier: "priority" };
    expect(applyFastServiceTier(flexPayload, codexModel)).toBe(flexPayload);
    expect(applyFastServiceTier(priorityPayload, codexModel)).toBe(priorityPayload);
  });
});

describe("/fast extension", () => {
  it.each(["gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"])("toggles /fast and patches %s requests only while enabled", async (id) => {
    const pi = createCodexPi();
    registerCodexFastExtension(pi as any);
    const ctx = createMockCtx({ model: getCodexModel(id) });

    await runCommand(pi, "fast", "", ctx);
    expect(pi.entries).toEqual([{ customType: FAST_STATE_ENTRY, data: { enabled: true } }]);
    expect(ctx.ui.statuses.get("codex-fast")).toBe("fast: on");
    expect(ctx.ui.notifications.at(-1)).toMatchObject({ level: "warning" });

    const payload = codexPayload(id);
    const [patched] = await emitEvent(pi, "before_provider_request", { payload }, ctx);
    expect(patched).toEqual({ ...payload, service_tier: "priority" });

    await runCommand(pi, "fast", "", ctx);
    expect(pi.entries.at(-1)).toEqual({ customType: FAST_STATE_ENTRY, data: { enabled: false } });
    expect(ctx.ui.statuses.get("codex-fast")).toBeUndefined();
    const [unchanged] = await emitEvent(pi, "before_provider_request", { payload }, ctx);
    expect(unchanged).toBeUndefined();
  });

  it("restores the latest branch state on session start and tree navigation", async () => {
    const pi = createCodexPi();
    registerCodexFastExtension(pi as any);
    const entries = [stateEntry(true), stateEntry(false), stateEntry(true)];
    const ctx = createMockCtx({ model: codexModel, entries });

    await emitEvent(pi, "session_start", {}, ctx);
    expect(ctx.ui.statuses.get("codex-fast")).toBe("fast: on");

    entries.push(stateEntry(false));
    await emitEvent(pi, "session_tree", {}, ctx);
    expect(ctx.ui.statuses.get("codex-fast")).toBeUndefined();
  });

  it("keeps enabled state waiting while the current model is unsupported", async () => {
    const pi = createCodexPi();
    registerCodexFastExtension(pi as any);
    const ctx = createMockCtx({ model: { id: "claude", provider: "anthropic", api: "anthropic-messages" } });

    await runCommand(pi, "fast", "on", ctx);
    expect(ctx.ui.statuses.get("codex-fast")).toBe("fast: waiting");
    expect(ctx.ui.notifications.at(-1).message).toContain("inactive");

    await emitEvent(pi, "model_select", { model: codexModel }, ctx);
    expect(ctx.ui.statuses.get("codex-fast")).toBe("fast: on");
  });

  it("reports status without adding duplicate state entries and rejects unknown arguments", async () => {
    const pi = createCodexPi();
    registerCodexFastExtension(pi as any);
    const ctx = createMockCtx({ model: codexModel });

    await runCommand(pi, "fast", "on", ctx);
    await runCommand(pi, "fast", "status", ctx);
    await runCommand(pi, "fast", "on", ctx);
    expect(pi.entries).toHaveLength(1);
    expect(ctx.ui.notifications.at(-1).message).toContain("on for openai-codex/gpt-5.6-sol");

    await runCommand(pi, "fast", "maybe", ctx);
    expect(ctx.ui.notifications.at(-1)).toMatchObject({ level: "error", message: "Usage: /fast [on|off|status]" });
  });
});

describe("Fast state restoration", () => {
  it("uses the latest valid branch entry and defaults off", () => {
    expect(restoreFastState([])).toBe(false);
    expect(restoreFastState([stateEntry(true), { type: "custom", customType: FAST_STATE_ENTRY, data: {} }, stateEntry(false)])).toBe(false);
  });
});
