export interface Capability {
  id: string;
  title: string;
  commands?: string[];
  tools?: string[];
  prompt?: string;
  enabled?: boolean | (() => boolean);
  priority?: number;
}

export function createCapabilityRegistry() {
  const capabilities = new Map<string, Capability>();
  const isEnabled = (capability: Capability) =>
    typeof capability.enabled === "function" ? capability.enabled() : capability.enabled !== false;

  return {
    register(capability: Capability) {
      capabilities.set(capability.id, capability);
    },
    unregister(id: string) {
      capabilities.delete(id);
    },
    get(id: string) {
      return capabilities.get(id);
    },
    list() {
      return [...capabilities.values()]
        .filter(isEnabled)
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
    },
    render() {
      const lines = this.list().map((capability) => {
        const details = [
          capability.commands?.length ? `commands: ${capability.commands.join(", ")}` : "",
          capability.tools?.length ? `tools: ${capability.tools.join(", ")}` : "",
        ].filter(Boolean);
        const suffix = details.length ? ` (${details.join("; ")})` : "";
        const prompt = capability.prompt ? ` — ${capability.prompt}` : "";
        return `- ${capability.title}${suffix}${prompt}`;
      });
      return lines.length ? `Pip extension capabilities:\n${lines.join("\n")}` : "";
    },
  };
}
