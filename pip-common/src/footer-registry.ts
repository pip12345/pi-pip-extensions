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

const FOOTER_ITEMS_KEY = Symbol.for("pip-common.footer-item-registry");

export function getPipFooterItemRegistry(): Map<string, PipFooterItemProvider> {
  const globalState = globalThis as any;
  if (!globalState[FOOTER_ITEMS_KEY]) globalState[FOOTER_ITEMS_KEY] = new Map<string, PipFooterItemProvider>();
  return globalState[FOOTER_ITEMS_KEY];
}

export function registerFooterItem(provider: PipFooterItemProvider): () => void {
  const registry = getPipFooterItemRegistry();
  registry.set(provider.id, provider);
  return () => registry.delete(provider.id);
}

export function registerFooterLine(provider: PipFooterLineProvider): () => void {
  return registerFooterItem({
    ...provider,
    region: "below",
    render: (context) => provider.render(context),
  });
}

export function renderRegisteredFooterItems(context: PipFooterItemContext): string[] {
  return [...getPipFooterItemRegistry().values()]
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

export function renderRegisteredFooterLines(context: PipFooterLineContext): string[] {
  return renderRegisteredFooterItems({ ...context, region: "below" });
}
