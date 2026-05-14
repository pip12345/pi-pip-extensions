export type SettingType = "boolean" | "string" | "number" | "enum";

export interface SettingDefinition<T = any> {
  type: SettingType;
  default: T;
  description?: string;
  choices?: readonly T[];
  validate?: (value: unknown) => value is T;
}

export type SettingsDefinition = Record<string, SettingDefinition>;

function baseValidate(definition: SettingDefinition, value: unknown): boolean {
  if (definition.validate) return definition.validate(value);
  if (definition.type === "boolean") return typeof value === "boolean";
  if (definition.type === "string") return typeof value === "string";
  if (definition.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (definition.type === "enum") return Boolean(definition.choices?.includes(value));
  return false;
}

export const setting = {
  boolean(defaultValue: boolean, description?: string): SettingDefinition<boolean> {
    return { type: "boolean", default: defaultValue, description };
  },
  string(defaultValue: string, description?: string): SettingDefinition<string> {
    return { type: "string", default: defaultValue, description };
  },
  number(defaultValue: number, description?: string): SettingDefinition<number> {
    return { type: "number", default: defaultValue, description };
  },
  enum<const T extends string>(defaultValue: T, choices: readonly T[], description?: string): SettingDefinition<T> {
    return { type: "enum", default: defaultValue, choices, description };
  },
};

export function createSettingsRegistry(initialValues: Record<string, Record<string, unknown>> = {}) {
  const definitions = new Map<string, SettingsDefinition>();
  const values = new Map<string, Record<string, unknown>>();

  function ensureSection(plugin: string) {
    if (!values.has(plugin)) values.set(plugin, { ...(initialValues[plugin] ?? {}) });
    return values.get(plugin)!;
  }

  return {
    register(plugin: string, definition: SettingsDefinition) {
      definitions.set(plugin, definition);
      const section = ensureSection(plugin);
      for (const [key, settingDefinition] of Object.entries(definition)) {
        if (!baseValidate(settingDefinition, section[key])) section[key] = settingDefinition.default;
      }
    },
    definition(plugin: string) {
      return definitions.get(plugin);
    },
    get<T = unknown>(path: string): T {
      const [plugin, key] = path.split(".", 2);
      if (!plugin || !key) throw new Error(`Invalid setting path: ${path}`);
      const definition = definitions.get(plugin)?.[key];
      if (!definition) throw new Error(`Unknown setting: ${path}`);
      const value = ensureSection(plugin)[key];
      return (baseValidate(definition, value) ? value : definition.default) as T;
    },
    set(path: string, value: unknown) {
      const [plugin, key] = path.split(".", 2);
      if (!plugin || !key) throw new Error(`Invalid setting path: ${path}`);
      const definition = definitions.get(plugin)?.[key];
      if (!definition) throw new Error(`Unknown setting: ${path}`);
      if (!baseValidate(definition, value)) throw new Error(`Invalid value for setting: ${path}`);
      ensureSection(plugin)[key] = value;
    },
    all() {
      const out: Record<string, Record<string, unknown>> = {};
      for (const plugin of definitions.keys()) out[plugin] = { ...ensureSection(plugin) };
      return out;
    },
  };
}
