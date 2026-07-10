import type { Api, Model } from "@earendil-works/pi-ai";

export interface ModelPatchMetadata {
  name: string;
  api: Api;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: ("text" | "image")[];
  cost: Model<Api>["cost"];
  contextWindow: number;
  maxTokens: number;
  compat?: Model<Api>["compat"];
}

export interface PatchModelDefinition {
  /** Model id sent to the target provider. */
  id: string;
  /** Existing Pi model to copy capability metadata from: provider/model-id. */
  metadataFrom?: string;
  /** Target-provider model whose endpoint, headers, API, and compatibility behavior are reused. */
  templateModel?: string;
  /** Full fallback metadata or partial overrides on top of metadataFrom. */
  metadata?: Partial<ModelPatchMetadata>;
}

export interface ProviderModelPatch {
  /** Stable settings/config key. */
  id: string;
  label: string;
  provider: string;
  templateModel: string;
  models: PatchModelDefinition[];
  source: "builtin" | "user";
}

export interface UserModelPatchesFile {
  patches: Array<Omit<ProviderModelPatch, "source">>;
}

export interface PatchBuildResult {
  provider: string;
  models: Model<Api>[];
  addedIds: string[];
  templates: Model<Api>[];
}
