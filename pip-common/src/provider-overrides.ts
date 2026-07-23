import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piRuntimeKey } from "./runtime.ts";

export type ProviderOverrideRole = "catalog" | "transport";
export type ProviderOverrideConfig = Record<string, any>;

export interface ProviderOverrideContributor {
  id: string;
  role: ProviderOverrideRole;
}

export interface ProviderOverrideHandle {
  set(provider: string, config: ProviderOverrideConfig): void;
  remove(provider: string): void;
  dispose(): void;
}

interface Contribution extends ProviderOverrideContributor {
  owner: symbol;
  config: ProviderOverrideConfig;
}

interface ProviderOverrideRuntime {
  pi: ExtensionAPI;
  contributions: Map<string, Map<ProviderOverrideRole, Contribution>>;
  applied: Map<string, ProviderOverrideConfig>;
  activeHandles: number;
}

const PROVIDER_OVERRIDE_RUNTIMES_KEY = Symbol.for("pip-common.provider-overrides.runtime-states");

function runtimes(): WeakMap<object, ProviderOverrideRuntime> {
  const globalState = globalThis as any;
  if (!globalState[PROVIDER_OVERRIDE_RUNTIMES_KEY]) globalState[PROVIDER_OVERRIDE_RUNTIMES_KEY] = new WeakMap<object, ProviderOverrideRuntime>();
  return globalState[PROVIDER_OVERRIDE_RUNTIMES_KEY];
}

function runtimeFor(pi: ExtensionAPI): ProviderOverrideRuntime {
  const key = piRuntimeKey(pi);
  let runtime = runtimes().get(key);
  if (!runtime) {
    runtime = { pi, contributions: new Map(), applied: new Map(), activeHandles: 0 };
    runtimes().set(key, runtime);
  }
  return runtime;
}

export function composeProviderOverride(catalog?: ProviderOverrideConfig, transport?: ProviderOverrideConfig): ProviderOverrideConfig | undefined {
  if (!catalog && !transport) return undefined;
  const composed = { ...(catalog ?? {}), ...(transport ?? {}) };
  if (catalog?.headers || transport?.headers) composed.headers = { ...(catalog?.headers ?? {}), ...(transport?.headers ?? {}) };
  if (Array.isArray(catalog?.models)) {
    composed.models = catalog.models.map((model: any) => transport?.baseUrl ? { ...model, baseUrl: transport.baseUrl } : { ...model });
  }
  return composed;
}

function reconcile(runtime: ProviderOverrideRuntime, provider: string): void {
  const previous = runtime.applied.get(provider);
  if (previous) {
    runtime.pi.unregisterProvider(provider);
    runtime.applied.delete(provider);
  }
  const contributions = runtime.contributions.get(provider);
  const config = composeProviderOverride(contributions?.get("catalog")?.config, contributions?.get("transport")?.config);
  if (!config) return;
  try {
    runtime.pi.registerProvider(provider, config as any);
    runtime.applied.set(provider, config);
  } catch (error) {
    if (previous) {
      runtime.pi.registerProvider(provider, previous as any);
      runtime.applied.set(provider, previous);
    }
    throw error;
  }
}

export function registerProviderOverrideContributor(pi: ExtensionAPI, contributor: ProviderOverrideContributor): ProviderOverrideHandle {
  if (!contributor.id.trim()) throw new Error("Provider override contributor id is required");
  const runtime = runtimeFor(pi);
  const owner = Symbol(contributor.id);
  const ownedProviders = new Set<string>();
  let disposed = false;
  runtime.activeHandles++;

  const assertActive = () => {
    if (disposed) throw new Error(`Provider override contributor ${contributor.id} is disposed`);
  };
  const set = (provider: string, config: ProviderOverrideConfig) => {
    assertActive();
    let contributions = runtime.contributions.get(provider);
    if (!contributions) {
      contributions = new Map();
      runtime.contributions.set(provider, contributions);
    }
    const current = contributions.get(contributor.role);
    if (current && current.owner !== owner) {
      throw new Error(`Provider ${provider} already has ${contributor.role} owner ${current.id}; ${contributor.id} cannot also own it`);
    }
    contributions.set(contributor.role, { ...contributor, owner, config: { ...config } });
    try {
      reconcile(runtime, provider);
      ownedProviders.add(provider);
    } catch (error) {
      if (current) contributions.set(contributor.role, current);
      else contributions.delete(contributor.role);
      if (!contributions.size) runtime.contributions.delete(provider);
      throw error;
    }
  };
  const remove = (provider: string) => {
    const contributions = runtime.contributions.get(provider);
    const current = contributions?.get(contributor.role);
    if (!current || current.owner !== owner) return;
    contributions!.delete(contributor.role);
    if (!contributions!.size) runtime.contributions.delete(provider);
    try {
      reconcile(runtime, provider);
      ownedProviders.delete(provider);
    } catch (error) {
      let restored = runtime.contributions.get(provider);
      if (!restored) {
        restored = new Map();
        runtime.contributions.set(provider, restored);
      }
      restored.set(contributor.role, current);
      throw error;
    }
  };
  return {
    set,
    remove,
    dispose: () => {
      if (disposed) return;
      for (const provider of [...ownedProviders]) remove(provider);
      disposed = true;
      runtime.activeHandles--;
      if (!runtime.activeHandles && !runtime.contributions.size && !runtime.applied.size) runtimes().delete(piRuntimeKey(runtime.pi));
    },
  };
}
