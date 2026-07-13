import type { Api, Model } from "@earendil-works/pi-ai";
import { githubCopilotOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import type { ProviderModelPatch } from "./types.ts";

export interface BuiltinPatchProviderCatalog {
  models: Model<Api>[];
  oauth: Omit<typeof githubCopilotOAuthProvider, "id">;
}

export function getBuiltinPatchProviderCatalog(provider: string): BuiltinPatchProviderCatalog | undefined {
  if (provider !== "github-copilot") return undefined;

  const builtinProvider = githubCopilotProvider();
  const { id: _id, ...oauth } = githubCopilotOAuthProvider;
  return {
    models: [...builtinProvider.getModels()] as Model<Api>[],
    oauth,
  };
}

const GPT_56_COMMON = {
  api: "openai-responses",
  reasoning: true,
  thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
  input: ["text", "image"] as ("text" | "image")[],
  contextWindow: 272000,
  maxTokens: 128000,
};

export const BUILTIN_MODEL_PATCHES: ProviderModelPatch[] = [
  {
    id: "github-copilot-gpt-5-6",
    label: "GitHub Copilot · GPT-5.6",
    provider: "github-copilot",
    templateModel: "gpt-5.5",
    source: "builtin",
    models: [
      {
        id: "gpt-5.6-sol",
        metadataFrom: "openai/gpt-5.6-sol",
        metadata: {
          ...GPT_56_COMMON,
          name: "GPT-5.6 Sol",
          cost: {
            input: 5,
            output: 30,
            cacheRead: 0.5,
            cacheWrite: 6.25,
            tiers: [{ inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }],
          } as any,
        },
      },
      {
        id: "gpt-5.6-terra",
        metadataFrom: "openai/gpt-5.6-terra",
        metadata: {
          ...GPT_56_COMMON,
          name: "GPT-5.6 Terra",
          cost: {
            input: 2.5,
            output: 15,
            cacheRead: 0.25,
            cacheWrite: 3.125,
            tiers: [{ inputTokensAbove: 272000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 6.25 }],
          } as any,
        },
      },
      {
        id: "gpt-5.6-luna",
        metadataFrom: "openai/gpt-5.6-luna",
        metadata: {
          ...GPT_56_COMMON,
          name: "GPT-5.6 Luna",
          cost: {
            input: 1,
            output: 6,
            cacheRead: 0.1,
            cacheWrite: 1.25,
            tiers: [{ inputTokensAbove: 272000, input: 2, output: 9, cacheRead: 0.2, cacheWrite: 2.5 }],
          } as any,
        },
      },
    ],
  },
];
