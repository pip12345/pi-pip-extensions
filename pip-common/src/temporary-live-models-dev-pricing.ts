import { normalizeUsage } from "./usage.ts";

// Temporary workaround until Pi's bundled models.dev data includes current GitHub Copilot pricing.
// Remove this file and its call sites once upstream Pi updates.

type ModelsDevModel = {
  id?: string;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
};

type ModelsDevProvider = {
  models?: Record<string, ModelsDevModel>;
};

type ModelsDevData = Record<string, ModelsDevProvider>;

const MODELS_DEV_URL = "https://models.dev/api.json";
const COPILOT_PROVIDER_ID = "github-copilot";

let liveDataPromise: Promise<ModelsDevData | undefined> | undefined;

function isCopilotProvider(provider: unknown): boolean {
  return typeof provider === "string" && provider.toLowerCase().includes("copilot");
}

function modelCandidates(model: string): string[] {
  const trimmed = model.trim();
  const slashTail = trimmed.split("/").filter(Boolean).at(-1);
  const colonTail = trimmed.split(":").filter(Boolean).at(-1);
  return Array.from(new Set([trimmed, slashTail, colonTail].filter((v): v is string => !!v)));
}

async function getLiveModelsDevData(): Promise<ModelsDevData | undefined> {
  if (!liveDataPromise) {
    liveDataPromise = fetch(MODELS_DEV_URL)
      .then(async (response) => (response.ok ? ((await response.json()) as ModelsDevData) : undefined))
      .catch(() => undefined);
  }
  return liveDataPromise;
}

async function findLiveCopilotModel(model: unknown): Promise<ModelsDevModel | undefined> {
  if (typeof model !== "string" || !model.trim()) return undefined;
  const data = await getLiveModelsDevData();
  const models = data?.[COPILOT_PROVIDER_ID]?.models;
  if (!models) return undefined;
  for (const candidate of modelCandidates(model)) {
    const found = models[candidate];
    if (found?.cost) return found;
  }
  return undefined;
}

export async function applyTemporaryLiveModelsDevCostFallback(message: any): Promise<boolean> {
  if (!message?.usage || !isCopilotProvider(message.provider)) return false;

  const usage = normalizeUsage(message.usage);
  if (!usage || usage.cost > 0) return false;

  const liveModel = await findLiveCopilotModel(message.model);
  const cost = liveModel?.cost;
  if (!cost) return false;

  const total =
    (usage.input * (cost.input ?? 0) +
      usage.output * (cost.output ?? 0) +
      usage.cacheRead * (cost.cache_read ?? cost.input ?? 0) +
      usage.cacheWrite * (cost.cache_write ?? cost.input ?? 0)) /
    1_000_000;

  if (!Number.isFinite(total) || total <= 0) return false;

  if (typeof message.usage.cost === "object" && message.usage.cost) message.usage.cost.total = total;
  else message.usage.cost = { total };
  return true;
}
