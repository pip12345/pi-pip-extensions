import { createProvider, type Model, type ModelThinkingLevel, type Provider, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { authenticated, baseOptions, executable, loadSDK, probe, requireExecutable, type DiscoveredModel } from "./sdk.ts";
import { ClaudeRuntime } from "./runtime.ts";

export const PROVIDER_ID = "claude-agent";
export const API_ID = "claude-agent-sdk";
export const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORTS = [undefined, "low", "low", "medium", "high", "xhigh", "max"] as const;

export function modelDefinition(model: DiscoveredModel, priced: boolean): Model<typeof API_ID> {
  const known = getBuiltinModels("anthropic").find((entry) => entry.id === model.resolvedModel?.replace(/\[1m\]$/, ""));
  const thinkingLevelMap: ThinkingLevelMap = { off: model.supportsThinkingOff === true ? "off" : null };
  for (let i = 1; i < LEVELS.length; i++) {
    const effort = EFFORTS[i];
    thinkingLevelMap[LEVELS[i]!] = effort && model.supportedEffortLevels?.includes(effort) ? effort : null;
  }
  return {
    type: "chat", id: model.value, name: `Claude Agent: ${model.displayName}`, provider: PROVIDER_ID, api: API_ID,
    baseUrl: DEFAULT_BASE_URL, reasoning: !!model.supportedEffortLevels?.length, thinkingLevelMap,
    input: ["text", "image"], cost: priced && known ? known.cost : ZERO_COST,
    contextWindow: model.contextWindow ?? known?.contextWindow ?? 200_000,
    maxTokens: known?.maxTokens ?? 0,
  };
}

export function createClaudeProvider(runtime: ClaudeRuntime, cwd: () => string): Provider {
  return createProvider({
    id: PROVIDER_ID,
    name: "Claude Agent",
    baseUrl: DEFAULT_BASE_URL,
    models: [],
    auth: {
      apiKey: {
        name: "Claude Code external login (claude auth login)",
        async resolve({ ctx, signal }) {
          const path = await ctx.env("PI_CLAUDE_PATH");
          signal.throwIfAborted();
          const env = path ? { PI_CLAUDE_PATH: path } : undefined;
          const cliEnv = { ...process.env, ...env };
          const cli = executable(cliEnv);
          if (!cli || !await authenticated(cli, cwd(), cliEnv, signal)) return undefined;
          return { auth: {}, env, source: "Claude Code external login" };
        },
      },
    },
    async fetchModels(context) {
      const env = { ...process.env, ...(context.credential?.type === "api_key" ? context.credential.env : {}) };
      const path = requireExecutable(env);
      const sdk = await loadSDK();
      const found = await probe(sdk, baseOptions(path, cwd(), env), context.signal);
      const priced = !env.ANTHROPIC_BASE_URL && found.account.apiProvider === "firstParty" && !!found.account.apiKeySource;
      return found.models.map((model) => modelDefinition(model, priced));
    },
    api: {
      stream: (model, context, options) => runtime.stream(model, context, options),
      streamSimple: (model, context, options) => runtime.stream(model, context, options),
    },
  });
}
