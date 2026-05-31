import type { ExtensionContextLike } from "./pi-api.ts";

export interface WidgetRestackerOptions {
  watchedPlacement?: string;
  ignoredKey?: string;
  restack: () => void;
}

export function installWidgetRestacker(ctx: ExtensionContextLike, options: WidgetRestackerOptions): () => void {
  const originalMethod = ctx.ui?.setWidget;
  const original = originalMethod?.bind(ctx.ui);
  if (!ctx.ui || !original) return () => undefined;

  let restacking = false;
  const watchedPlacement = options.watchedPlacement ?? "aboveEditor";

  ctx.ui.setWidget = (key: string, content: any, widgetOptions?: any) => {
    const result = original(key, content, widgetOptions);
    const placement = widgetOptions?.placement ?? "aboveEditor";
    if (!restacking && key !== options.ignoredKey && placement === watchedPlacement) {
      restacking = true;
      try {
        options.restack();
      } finally {
        restacking = false;
      }
    }
    return result;
  };

  return () => {
    if (ctx.ui?.setWidget !== originalMethod) ctx.ui!.setWidget = originalMethod;
  };
}
