import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCodexImageGeneration } from "./image-gen.ts";

export const FAST_STATE_ENTRY = "pi-codex-fast-state";
export const FAST_STATUS_KEY = "codex-fast";
export const FAST_SERVICE_TIER = "priority";
export const LONG_CONTEXT_WINDOW = 1_050_000;

const OPENAI_CODEX_PROVIDER = "openai-codex";
const LONG_CONTEXT_MODEL_IDS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
const OPENAI_CODEX_API = "openai-codex-responses";
const DOCUMENTED_FAST_MODEL_FAMILY = /^gpt-5\.(?:4|5|6)(?:$|-)/;

interface FastStateEntryData {
  enabled: boolean;
}

interface FastModelLike {
  id?: unknown;
  provider?: unknown;
  api?: unknown;
  serviceTiers?: unknown;
  service_tiers?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function explicitFastCapability(model: FastModelLike): boolean | undefined {
  const hasCamelCase = Object.hasOwn(model, "serviceTiers");
  const hasSnakeCase = Object.hasOwn(model, "service_tiers");
  if (!hasCamelCase && !hasSnakeCase) return undefined;

  const tiers = hasCamelCase ? model.serviceTiers : model.service_tiers;
  if (!Array.isArray(tiers)) return false;
  return tiers.some((tier) => {
    if (!isRecord(tier)) return false;
    return tier.id === FAST_SERVICE_TIER && typeof tier.name === "string" && tier.name.toLowerCase() === "fast";
  });
}

/**
 * Prefer explicit catalog capability metadata when Pi exposes it. The family
 * fallback is intentionally bounded to the model families OpenAI currently
 * documents instead of assuming every present or future Codex model is eligible.
 */
export function isFastCapableCodexModel(model: unknown): model is FastModelLike & { id: string } {
  if (!isRecord(model)) return false;
  if (model.provider !== OPENAI_CODEX_PROVIDER || model.api !== OPENAI_CODEX_API || typeof model.id !== "string") return false;

  const explicitCapability = explicitFastCapability(model);
  return explicitCapability ?? DOCUMENTED_FAST_MODEL_FAMILY.test(model.id);
}

/** Patch only a fully recognizable Codex Responses request and never replace another tier. */
export function applyFastServiceTier(payload: unknown, model: unknown): unknown {
  if (!isFastCapableCodexModel(model) || !isRecord(payload)) return payload;
  if (payload.model !== model.id || payload.stream !== true || payload.store !== false || !Array.isArray(payload.input)) return payload;
  if (Object.hasOwn(payload, "service_tier")) return payload;
  return { ...payload, service_tier: FAST_SERVICE_TIER };
}

export function applyLongContextWindow<T extends { id: string; provider?: unknown; contextWindow: number }>(model: T): T {
  if (model.provider !== OPENAI_CODEX_PROVIDER || !LONG_CONTEXT_MODEL_IDS.has(model.id) || model.contextWindow === LONG_CONTEXT_WINDOW) return model;
  return { ...model, contextWindow: LONG_CONTEXT_WINDOW };
}

export function restoreFastState(entries: readonly unknown[]): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== FAST_STATE_ENTRY || !isRecord(entry.data)) continue;
    if (typeof entry.data.enabled === "boolean") return entry.data.enabled;
  }
  return false;
}

function currentBranch(ctx: ExtensionContext): readonly unknown[] {
  return ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
}

function modelLabel(model: unknown): string {
  if (!isRecord(model)) return "no active model";
  const provider = typeof model.provider === "string" ? model.provider : "unknown-provider";
  const id = typeof model.id === "string" ? model.id : "unknown-model";
  return `${provider}/${id}`;
}

function statusMessage(enabled: boolean, model: unknown): string {
  if (!enabled) return "Codex Fast mode: off.";
  if (isFastCapableCodexModel(model)) {
    return `Codex Fast mode: on for ${modelLabel(model)}. Requests use the priority service tier with increased usage or cost.`;
  }
  return `Codex Fast mode: on, but inactive for ${modelLabel(model)}. It applies automatically only to supported OpenAI Codex models.`;
}

export default function registerCodexExtension(pi: ExtensionAPI): void {
  registerCodexImageGeneration(pi);

  let enabled = false;

  const activateLongContext = (model: unknown) => {
    if (!isRecord(model) || typeof model.id !== "string" || typeof model.contextWindow !== "number") return;
    const nextModel = applyLongContextWindow(model as Record<string, unknown> & { id: string; contextWindow: number });
    if (nextModel !== model) model.contextWindow = nextModel.contextWindow;
  };

  const updateStatus = (ctx: ExtensionContext, model: unknown = ctx.model) => {
    const value = enabled ? (isFastCapableCodexModel(model) ? "fast: on" : "fast: waiting") : undefined;
    ctx.ui.setStatus(FAST_STATUS_KEY, value);
  };

  const restore = (ctx: ExtensionContext) => {
    enabled = restoreFastState(currentBranch(ctx));
    updateStatus(ctx);
  };

  pi.registerCommand("fast", {
    description: "Enable, disable, or inspect OpenAI Codex Fast mode",
    getArgumentCompletions: (prefix: string) => {
      const choices = ["on", "off", "status"];
      const matches = choices.filter((value) => value.startsWith(prefix.toLowerCase())).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase() || "toggle";
      if (command === "status") {
        updateStatus(ctx);
        ctx.ui.notify(statusMessage(enabled, ctx.model), "info");
        return;
      }
      if (command !== "toggle" && command !== "on" && command !== "off") {
        ctx.ui.notify("Usage: /fast [on|off|status]", "error");
        return;
      }

      const nextEnabled = command === "toggle" ? !enabled : command === "on";
      if (nextEnabled !== enabled) {
        enabled = nextEnabled;
        pi.appendEntry(FAST_STATE_ENTRY, { enabled } satisfies FastStateEntryData);
      }
      updateStatus(ctx);
      ctx.ui.notify(statusMessage(enabled, ctx.model), enabled ? "warning" : "info");
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled) return;
    const nextPayload = applyFastServiceTier(event.payload, ctx.model);
    return nextPayload === event.payload ? undefined : nextPayload;
  });

  pi.on("session_start", async (_event, ctx) => {
    activateLongContext(ctx.model);
    restore(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("model_select", async (event, ctx) => {
    activateLongContext(event.model);
    updateStatus(ctx, event.model);
  });
}
