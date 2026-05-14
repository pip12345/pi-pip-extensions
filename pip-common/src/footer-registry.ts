export interface PipFooterLineContext {
  width: number;
  theme: any;
  ctx: any;
}

export interface PipFooterLineProvider {
  id: string;
  priority?: number;
  enabled?: boolean | ((ctx: any) => boolean);
  render: (context: PipFooterLineContext) => string | string[] | undefined | null;
}

const FOOTER_LINES_KEY = Symbol.for("pip-common.footer-line-registry");

export function getPipFooterLineRegistry(): Map<string, PipFooterLineProvider> {
  const globalState = globalThis as any;
  if (!globalState[FOOTER_LINES_KEY]) globalState[FOOTER_LINES_KEY] = new Map<string, PipFooterLineProvider>();
  return globalState[FOOTER_LINES_KEY];
}

export function registerFooterLine(provider: PipFooterLineProvider): () => void {
  const registry = getPipFooterLineRegistry();
  registry.set(provider.id, provider);
  return () => registry.delete(provider.id);
}

export function renderRegisteredFooterLines(context: PipFooterLineContext): string[] {
  return [...getPipFooterLineRegistry().values()]
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
