import { getPipSettingsRegistry, pipSettings, type SettingChange, type SettingSection, type SettingsRegistry } from "./settings.ts";
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

export function settingsFor(id: string): ScopedSettings;
export function settingsFor(pi: PiRuntimeOwner, id: string): ScopedSettings;
export function settingsFor(piOrId: PiRuntimeOwner | string, maybeId?: string): ScopedSettings {
  if (typeof piOrId === "string") return scopedSettings(pipSettings, piOrId);
  return scopedSettings(getPipSettingsRegistry(piOrId), maybeId!);
}

export function settingsForSection(section: Pick<SettingSection, "id">): ScopedSettings;
export function settingsForSection(pi: PiRuntimeOwner, section: Pick<SettingSection, "id">): ScopedSettings;
export function settingsForSection(piOrSection: PiRuntimeOwner | Pick<SettingSection, "id">, maybeSection?: Pick<SettingSection, "id">): ScopedSettings {
  if (maybeSection) return settingsFor(piOrSection as PiRuntimeOwner, maybeSection.id);
  return settingsFor((piOrSection as Pick<SettingSection, "id">).id);
}
