export interface StatusEntry {
  text: string;
  priority?: number;
  enabled?: boolean;
}

export function createStatusBroker() {
  const entries = new Map<string, StatusEntry>();

  return {
    set(id: string, text: string, options: Omit<StatusEntry, "text"> = {}) {
      entries.set(id, { text, ...options });
    },
    delete(id: string) {
      entries.delete(id);
    },
    clear() {
      entries.clear();
    },
    get(id: string) {
      return entries.get(id);
    },
    list() {
      return [...entries.entries()]
        .filter(([, entry]) => entry.enabled !== false && entry.text.length > 0)
        .sort((a, b) => (b[1].priority ?? 0) - (a[1].priority ?? 0) || a[0].localeCompare(b[0]));
    },
    render(separator = "  ") {
      return this.list().map(([, entry]) => entry.text).join(separator);
    },
  };
}
