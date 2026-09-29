import { describe, expect, it } from "vitest";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createMockCtx, createMockPi, emitEvent, runCommand } from "../pip-common/testing.ts";
import registerCodexExtension, {
  FAST_SERVICE_TIER, FAST_STATE_ENTRY, LONG_CONTEXT_WINDOW,
  applyFastServiceTier, applyLongContextWindow, isFastCapableOpenAIModel, restoreFastState,
} from "./index.ts";

const codexModel = {
  id: "gpt-5.6-sol", provider: "openai-codex", api: "openai-codex-responses", contextWindow: 272_000,
};
const openaiModel = { ...codexModel, id: "gpt-6.1-sol", provider: "openai", api: "openai-responses" };
const longContextIds = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"];

function payload(model = codexModel.id) {
  return { model, store: false, stream: true, input: [], instructions: "test" };
}
function stateEntry(enabled: boolean) {
  return { type: "custom", customType: FAST_STATE_ENTRY, data: { enabled } };
}
function nativeModel(id: string, provider = "openai-codex") {
  const model = builtinProviders().find((candidate) => candidate.id === provider)!.getModels().find((model) => model.id === id);
  expect(model, `Pi's native catalog must include ${provider}/${id}`).toBeDefined();
  return structuredClone(model!);
}

function setup(model: any = codexModel, entries: any[] = []) {
  const pi = createMockPi();
  registerCodexExtension(pi as any);
  return { pi, ctx: createMockCtx({ model, entries }) };
}

describe("native OpenAI models", () => {
  it("leaves model catalogs and provider registration to Pi", () => {
    const { pi } = setup();
    expect(pi.providerRegistrations).toEqual([]);
    for (const provider of ["openai", "openai-codex"]) {
      for (const id of ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]) {
        expect(nativeModel(id, provider)).toMatchObject({ contextWindow: 272_000, maxTokens: 128_000 });
      }
    }
  });
});

describe("OpenAI long context", () => {
  it.each(["openai", "openai-codex"])("expands only documented models on %s", (provider) => {
    for (const id of longContextIds) {
      expect(applyLongContextWindow({ id, provider, contextWindow: 272_000 }).contextWindow).toBe(LONG_CONTEXT_WINDOW);
    }
    for (const id of ["gpt-5.5", "gpt-6.2-sol"]) {
      const model = { id, provider, contextWindow: 272_000 };
      expect(applyLongContextWindow(model)).toBe(model);
    }
    const other = { id: "gpt-6.1-sol", provider: "openrouter", contextWindow: 272_000 };
    expect(applyLongContextWindow(other)).toBe(other);
  });

  it.each([
    ...longContextIds.map((id) => ({ provider: "openai-codex", id })),
    { provider: "openai", id: "gpt-6.1-sol" },
  ])("changes only the active context window for $provider/$id", async ({ provider, id }) => {
    const catalogModel = nativeModel(id, provider);
    const activeModel = structuredClone(catalogModel);
    const { pi, ctx } = setup(activeModel);
    const expected = { ...catalogModel, contextWindow: LONG_CONTEXT_WINDOW };

    await emitEvent(pi, "session_start", {}, ctx);
    expect(activeModel).toEqual(expected);
    expect(applyLongContextWindow(activeModel)).toBe(activeModel);
    const selected = structuredClone(catalogModel);
    await emitEvent(pi, "model_select", { model: selected }, ctx);
    expect(selected).toEqual(expected);
    expect(catalogModel.contextWindow).toBe(272_000);
  });
});

describe("Fast capability", () => {
  it.each([codexModel, openaiModel])("accepts documented models on $provider", (model) => {
    for (const id of ["gpt-5.4-new-catalog-variant", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]) {
      expect(isFastCapableOpenAIModel({ ...model, id })).toBe(true);
    }
    for (const id of ["gpt-6.2-sol", "gpt-6-unknown", "gpt-5.3-codex-spark", "gpt-5.2-codex"]) {
      expect(isFastCapableOpenAIModel({ ...model, id })).toBe(false);
    }
  });

  it("prefers explicit catalog capabilities", () => {
    expect(isFastCapableOpenAIModel({ ...codexModel, id: "gpt-6", serviceTiers: [{ id: "priority", name: "Fast" }] })).toBe(true);
    expect(isFastCapableOpenAIModel({ ...openaiModel, service_tiers: [] })).toBe(false);
    expect(isFastCapableOpenAIModel({ ...codexModel, serviceTiers: [{ id: "flex", name: "Slow" }] })).toBe(false);
  });

  it("requires matching built-in provider and Responses API", () => {
    expect(isFastCapableOpenAIModel({ ...codexModel, provider: "openai" })).toBe(false);
    expect(isFastCapableOpenAIModel({ ...openaiModel, api: "openai-completions" })).toBe(false);
    expect(isFastCapableOpenAIModel({ ...openaiModel, provider: "openrouter" })).toBe(false);
  });
});

describe("request patching", () => {
  it.each([codexModel, openaiModel])("adds priority without mutating requests on $provider", (model) => {
    const request = payload(model.id);
    expect(applyFastServiceTier(request, model)).toEqual({ ...request, service_tier: FAST_SERVICE_TIER });
    expect(request).not.toHaveProperty("service_tier");
  });

  it("leaves mismatched, malformed, unsupported, and non-OpenAI requests untouched", () => {
    const request = payload();
    for (const [candidate, model] of [
      [{ ...request, model: "different" }, codexModel],
      [{ ...request, stream: false }, codexModel],
      [{ ...request, store: true }, codexModel],
      [{ ...request, input: "not-an-array" }, codexModel],
      [request, { ...codexModel, id: "gpt-5.3-codex-spark" }],
      [request, { ...codexModel, provider: "openrouter" }],
    ]) expect(applyFastServiceTier(candidate, model)).toBe(candidate);
  });

  it.each(["flex", "priority", "fast", "default"])("does not override an existing %s tier", (tier) => {
    const request = { ...payload(), service_tier: tier };
    expect(applyFastServiceTier(request, codexModel)).toBe(request);
  });
});

describe("/fast extension", () => {
  it.each([
    ...["gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"].map((id) => ({ provider: "openai-codex", id })),
    { provider: "openai", id: "gpt-6.1-sol" },
  ])("toggles and patches $provider/$id only while enabled", async ({ provider, id }) => {
    const { pi, ctx } = setup(nativeModel(id, provider));
    await runCommand(pi, "fast", "", ctx);
    expect(pi.entries).toEqual([{ customType: FAST_STATE_ENTRY, data: { enabled: true } }]);
    expect(ctx.ui.statuses.get("codex-fast")).toBe("fast: on");
    expect(ctx.ui.notifications.at(-1)).toMatchObject({ level: "warning" });

    const request = payload(id);
    expect(await emitEvent(pi, "before_provider_request", { payload: request }, ctx)).toEqual([{ ...request, service_tier: "priority" }]);
    await runCommand(pi, "fast", "", ctx);
    expect(pi.entries.at(-1)).toEqual({ customType: FAST_STATE_ENTRY, data: { enabled: false } });
    expect(ctx.ui.statuses.get("codex-fast")).toBeUndefined();
    expect(await emitEvent(pi, "before_provider_request", { payload: request }, ctx)).toEqual([undefined]);
  });

  it("restores state from the latest branch entry", async () => {
    const entries = [stateEntry(true), stateEntry(false), stateEntry(true)];
    const { pi, ctx } = setup(codexModel, entries);
    await emitEvent(pi, "session_start", {}, ctx);
    expect(ctx.ui.statuses.get("codex-fast")).toBe("fast: on");
    entries.push(stateEntry(false));
    await emitEvent(pi, "session_tree", {}, ctx);
    expect(ctx.ui.statuses.get("codex-fast")).toBeUndefined();
  });

  it("waits on unsupported models and activates when a supported model is selected", async () => {
    const { pi, ctx } = setup({ id: "claude", provider: "anthropic", api: "anthropic-messages" });
    await runCommand(pi, "fast", "on", ctx);
    expect(ctx.ui.statuses.get("codex-fast")).toBe("fast: waiting");
    expect(ctx.ui.notifications.at(-1).message).toContain("inactive");
    await emitEvent(pi, "model_select", { model: openaiModel }, ctx);
    expect(ctx.ui.statuses.get("codex-fast")).toBe("fast: on");
  });

  it("reports status without duplicating state and rejects unknown arguments", async () => {
    const { pi, ctx } = setup();
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
  it("uses the latest valid branch state and defaults off", () => {
    expect(restoreFastState([])).toBe(false);
    expect(restoreFastState([stateEntry(true), { type: "custom", customType: FAST_STATE_ENTRY, data: {} }, stateEntry(false)])).toBe(false);
  });
});
