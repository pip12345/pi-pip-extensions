import { existsSync, readFileSync } from "node:fs";
import { pipPath } from "../pip-common/index.ts";
import type { PatchModelDefinition, ProviderModelPatch, UserModelPatchesFile } from "./types.ts";

export const USER_PATCHES_PATH = pipPath("model-patches.json");

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function parseModel(raw: unknown, patchId: string, index: number): PatchModelDefinition {
  const value = record(raw, `Patch ${patchId} model ${index + 1}`);
  const id = nonEmptyString(value.id, `Patch ${patchId} model ${index + 1}.id`);
  const metadataFrom = value.metadataFrom === undefined ? undefined : nonEmptyString(value.metadataFrom, `Patch ${patchId} model ${id}.metadataFrom`);
  const templateModel = value.templateModel === undefined ? undefined : nonEmptyString(value.templateModel, `Patch ${patchId} model ${id}.templateModel`);
  const metadata = value.metadata === undefined ? undefined : record(value.metadata, `Patch ${patchId} model ${id}.metadata`);
  if (!metadataFrom && !metadata) throw new Error(`Patch ${patchId} model ${id} needs metadataFrom or metadata`);
  return { id, metadataFrom, templateModel, metadata: metadata as PatchModelDefinition["metadata"] };
}

function parsePatch(raw: unknown, index: number): ProviderModelPatch {
  const value = record(raw, `Patch ${index + 1}`);
  const id = nonEmptyString(value.id, `Patch ${index + 1}.id`);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`Patch id ${id} may contain only lowercase letters, numbers, dashes, and underscores`);
  const models = value.models;
  if (!Array.isArray(models) || !models.length) throw new Error(`Patch ${id}.models must be a non-empty array`);
  return {
    id,
    label: nonEmptyString(value.label, `Patch ${id}.label`),
    provider: nonEmptyString(value.provider, `Patch ${id}.provider`),
    templateModel: nonEmptyString(value.templateModel, `Patch ${id}.templateModel`),
    models: models.map((model, modelIndex) => parseModel(model, id, modelIndex)),
    source: "user",
  };
}

export function parseUserModelPatches(raw: unknown): ProviderModelPatch[] {
  const root = record(raw, "Model patches config");
  if (!Array.isArray(root.patches)) throw new Error("Model patches config.patches must be an array");
  return root.patches.map(parsePatch);
}

export function loadUserModelPatches(path = USER_PATCHES_PATH): ProviderModelPatch[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as UserModelPatchesFile;
  return parseUserModelPatches(parsed);
}

export function mergeModelPatches(builtin: ProviderModelPatch[], user: ProviderModelPatch[]): ProviderModelPatch[] {
  const merged: ProviderModelPatch[] = [];
  const ids = new Set<string>();
  for (const patch of [...builtin, ...user]) {
    if (ids.has(patch.id)) throw new Error(`Duplicate model patch id: ${patch.id}`);
    ids.add(patch.id);
    merged.push(patch);
  }
  return merged;
}
