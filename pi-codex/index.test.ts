import { describe, expect, it } from "vitest";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createMockCtx, createMockPi, emitEvent, runCommand } from "../pip-common/testing.ts";
import registerCodexFastExtension, {
  FAST_SERVICE_TIER,
  FAST_STATE_ENTRY,
  LONG_CONTEXT_WINDOW,
  applyFastServiceTier,
  applyLongContextWindow,
  isFastCapableCodexModel,
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

function nativeCodexModel(id: string) {
  const model = builtinProviders().find((provider) => provider.id === "openai-codex")?.getModels().find((model) => model.id === id);
  expect(model, `Pi's native Codex catalog must include ${id}`).toBeDefined();
  return structuredClone(model!);
}

describe("Codex model catalog", () => {
  it("leaves provider registration to Pi", () => {
    const pi = createCodexPi();
    registerCodexFastExtension(pi as any);

    expect(pi.providerRegistrations).toHaveLength(0);
  });
});

describe("Codex long context catalog", () => {
  it("expands GPT-5.6 variants and GPT-6 Astra without changing other models or providers", () => {
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"]) {
      expect(applyLongContextWindow({ id, provider: "openai-codex", contextWindow: 272_000 }).contextWindow).toBe(LONG_CONTEXT_WINDOW);
    }
    const older = { id: "gpt-5.5", provider: "openai-codex", contextWindow: 272_000 };
    const directOpenAI = { id: "gpt-5.6-sol", provider: "openai", contextWindow: 272_000 };
    expect(applyLongContextWindow(older)).toBe(older);
    expect(applyLongContextWindow(directOpenAI)).toBe(directOpenAI);
  });

  it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"])("sets only the context window when native %s becomes active", async (id) => {
    const pi = createCodexPi();
    registerCodexFastExtension(pi as any);
    const nativeModel = nativeCodexModel(id);
    expect(nativeModel.contextWindow).toBe(272_000);
    const expectedModel = { ...nativeModel, contextWindow: LONG_CONTEXT_WINDOW };
    const activeModel = structuredClone(nativeModel);
    const ctx = createMockCtx({ model: activeModel });

    await emitEvent(pi, "session_start", {}, ctx);
    expect(activeModel).toEqual(expectedModel);
    expect(applyLongContextWindow(activeModel)).toBe(activeModel);

    const selectedModel = structuredClone(nativeModel);
    await emitEvent(pi, "model_select", { model: selectedModel }, ctx);
    expect(selectedModel).toEqual(expectedModel);
  });
});

describe("Codex Fast capability", () => {
  it("accepts documented Codex model families without hardcoding catalog entries", () => {
    expect(isFastCapableCodexModel(codexModel)).toBe(true);
    expect(isFastCapableCodexModel({ ...codexModel, id: "gpt-5.4-new-catalog-variant" })).toBe(true);
    expect(isFastCapableCodexModel({ ...codexModel, id: "gpt-6-astra" })).toBe(true);
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
  it.each(["gpt-5.6-sol", "gpt-6-astra"])("toggles /fast and patches native %s requests only while enabled", async (id) => {
    const pi = createCodexPi();
    registerCodexFastExtension(pi as any);
    const ctx = createMockCtx({ model: nativeCodexModel(id) });

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
