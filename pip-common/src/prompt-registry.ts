export interface PromptProvider<Ctx = any> {
  id: string;
  priority?: number;
  enabled?: boolean | ((ctx: Ctx) => boolean | Promise<boolean>);
  build: (ctx: Ctx) => string | undefined | null | Promise<string | undefined | null>;
}

export interface BuildPromptOptions {
  includeErrors?: boolean;
}

export function createPromptRegistry<Ctx = any>() {
  const providers = new Map<string, PromptProvider<Ctx>>();

  const isEnabled = async (provider: PromptProvider<Ctx>, ctx: Ctx) => {
    if (typeof provider.enabled === "function") return Boolean(await provider.enabled(ctx));
    return provider.enabled !== false;
  };

  return {
    register(provider: PromptProvider<Ctx>) {
      providers.set(provider.id, provider);
    },
    unregister(id: string) {
      providers.delete(id);
    },
    get(id: string) {
      return providers.get(id);
    },
    list() {
      return [...providers.values()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
    },
    async buildAll(ctx: Ctx, options: BuildPromptOptions = {}) {
      const blocks: string[] = [];
      for (const provider of this.list()) {
        if (!(await isEnabled(provider, ctx))) continue;
        try {
          const block = await provider.build(ctx);
          if (block?.trim()) blocks.push(block.trim());
        } catch (error) {
          if (options.includeErrors) {
            const message = error instanceof Error ? error.message : String(error);
            blocks.push(`[${provider.id} prompt provider failed: ${message}]`);
          }
        }
      }
      return blocks.join("\n\n");
    },
  };
}
