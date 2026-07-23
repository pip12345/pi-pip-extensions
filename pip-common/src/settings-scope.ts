import { getPipSettingsRegistry, type SettingChange, type SettingSection, type SettingsRegistry } from "./settings.ts";
import type { PiRuntimeOwner } from "./runtime.ts";

export interface ScopedSettings {
  readonly id: string;
  get<T>(key: string, fallback: T): T;
  path(key: string): string;
  onChange(listener: (changes: readonly SettingChange[]) => void): () => void;
}

function scopedSettings(registry: SettingsRegistry, id: string): ScopedSettings {
  return {
    id,
    path(key: string) {
      return `${id}.${key}`;
    },
    get<T>(key: string, fallback: T): T {
      try {
        return registry.get<T>(`${id}.${key}`);
      } catch {
        return fallback;
      }
    },
    onChange(listener) {
      return registry.onChange((changes) => {
        const scoped = changes.filter((change) => change.section === id);
        if (scoped.length) listener(scoped);
      });
    },
  };
}

export function settingsFor(pi: PiRuntimeOwner, id: string): ScopedSettings {
  return scopedSettings(getPipSettingsRegistry(pi), id);
}

export function settingsForSection(pi: PiRuntimeOwner, section: Pick<SettingSection, "id">): ScopedSettings {
  return settingsFor(pi, section.id);
}
