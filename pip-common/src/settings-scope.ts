import { pipSettings, type SettingSection } from "./settings.ts";

export interface ScopedSettings {
  readonly id: string;
  get<T>(key: string, fallback: T): T;
  path(key: string): string;
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
  };
}

export function settingsForSection(section: Pick<SettingSection, "id">): ScopedSettings {
  return settingsFor(section.id);
}
