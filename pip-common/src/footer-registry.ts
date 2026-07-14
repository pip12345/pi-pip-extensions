import { piRuntimeKey, type PiRuntimeOwner } from "./runtime.ts";

export type PipFooterRegion = "right" | "below";

export interface PipFooterItemContext {
  width: number;
  theme: any;
  ctx: any;
  region: PipFooterRegion;
}

export interface PipFooterItemProvider {
  id: string;
  region?: PipFooterRegion;
  priority?: number;
  enabled?: boolean | ((ctx: any) => boolean);
  render: (context: PipFooterItemContext) => string | string[] | undefined | null;
}

export type PipFooterLineContext = Omit<PipFooterItemContext, "region">;
export type PipFooterLineProvider = Omit<PipFooterItemProvider, "region" | "render"> & {
  render: (context: PipFooterLineContext) => string | string[] | undefined | null;
};

interface FooterRuntimeState {
  key: object;
  items: Map<string, PipFooterItemProvider>;
}

const FOOTER_STATES_KEY = Symbol.for("pip-common.footer-runtime-states");

function footerStates(): WeakMap<object, FooterRuntimeState> {
  const globalState = globalThis as any;
  if (!globalState[FOOTER_STATES_KEY]) globalState[FOOTER_STATES_KEY] = new WeakMap<object, FooterRuntimeState>();
  return globalState[FOOTER_STATES_KEY];
}

export function getPipFooterItemRegistry(pi: PiRuntimeOwner): Map<string, PipFooterItemProvider> {
  const key = piRuntimeKey(pi);
  let state = footerStates().get(key);
  if (!state) {
    state = { key, items: new Map() };
    footerStates().set(key, state);
    const owner = pi as any;
    owner.on?.("session_shutdown", async () => {
      state!.items.clear();
      footerStates().delete(key);
    });
  }
  return state.items;
}

export function registerFooterItem(pi: PiRuntimeOwner, provider: PipFooterItemProvider): () => void {
  const registry = getPipFooterItemRegistry(pi);
  registry.set(provider.id, provider);
  return () => registry.delete(provider.id);
}

export function registerFooterLine(pi: PiRuntimeOwner, provider: PipFooterLineProvider): () => void {
  return registerFooterItem(pi, {
    ...provider,
    region: "below",
    render: (context) => provider.render(context),
  });
}

export function renderRegisteredFooterItems(pi: PiRuntimeOwner, context: PipFooterItemContext): string[] {
  return [...getPipFooterItemRegistry(pi).values()]
    .filter((provider) => (provider.region ?? "below") === context.region)
    .filter((provider) => {
      if (typeof provider.enabled === "function") return provider.enabled(context.ctx);
      return provider.enabled !== false;
    })
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))
    .flatMap((provider) => {
      const rendered = provider.render(context);
      if (!rendered) return [];
      return Array.isArray(rendered) ? rendered : [rendered];
    })
    .filter((line) => line.trim().length > 0);
}

export function renderRegisteredFooterLines(pi: PiRuntimeOwner, context: PipFooterLineContext): string[] {
  return renderRegisteredFooterItems(pi, { ...context, region: "below" });
}
