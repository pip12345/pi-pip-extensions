import { pipSettings, type SettingChange, type SettingSection } from "./settings.ts";

export interface ScopedSettings {
  readonly id: string;
  get<T>(key: string, fallback: T): T;
  path(key: string): string;
  onChange(listener: (changes: readonly SettingChange[]) => void): () => void;
}

export function settingsFor(id: string): ScopedSettings {
  return {
    id,
    path(key: string) {
      return `${id}.${key}`;
    },
    get<T>(key: string, fallback: T): T {
      try {
        return pipSettings.get<T>(`${id}.${key}`);
      } catch {
        return fallback;
      }
    },
    onChange(listener) {
      return pipSettings.onChange((changes) => {
        const scoped = changes.filter((change) => change.section === id);
        if (scoped.length) listener(scoped);
      });
    },
  };
}

export function settingsForSection(section: Pick<SettingSection, "id">): ScopedSettings {
  return settingsFor(section.id);
}
