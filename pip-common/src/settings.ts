import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pipPath } from "./paths.ts";

export type SettingType = "boolean" | "string" | "number" | "enum";

export interface SettingChoice<T = any> {
  value: T;
  label: string;
  description?: string;
}

export interface SettingDefinition<T = any> {
  type: SettingType;
  default: T;
  label?: string;
  description?: string;
  choices?: readonly T[];
  choiceLabels?: Partial<Record<string, string>>;
  validate?: (value: unknown) => value is T;
  order?: number;
  min?: number;
  max?: number;
  step?: number;
}

export interface SettingSection {
  id: string;
  title: string;
  description?: string;
  order?: number;
  settings: SettingsDefinition;
}

export interface SettingRow {
  section: SettingSection;
  key: string;
  definition: SettingDefinition;
  path: string;
}

export type SettingsDefinition = Record<string, SettingDefinition>;

export const DEFAULT_SETTINGS_PATH = pipPath("pip-settings.json");

function baseValidate(definition: SettingDefinition, value: unknown): boolean {
  let valid = false;
  if (definition.type === "boolean") valid = typeof value === "boolean";
  else if (definition.type === "string") valid = typeof value === "string";
  else if (definition.type === "number") {
    valid = typeof value === "number" && Number.isFinite(value);
    if (valid && definition.min !== undefined) valid = (value as number) >= definition.min;
    if (valid && definition.max !== undefined) valid = (value as number) <= definition.max;
  } else if (definition.type === "enum") valid = Boolean(definition.choices?.includes(value));
  if (!valid) return false;
  return definition.validate ? definition.validate(value) : true;
}

function labelFromKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeChoice<T>(choice: T, definition: SettingDefinition): SettingChoice<T> {
  const label = definition.choiceLabels?.[String(choice)] ?? String(choice);
  return { value: choice, label };
}

export interface SettingsLoadResult {
  values: Record<string, Record<string, unknown>>;
  error?: Error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readSettingsFile(path: string): SettingsLoadResult {
  if (!existsSync(path)) return { values: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || Object.values(parsed).some((section) => !isRecord(section))) {
      throw new Error("settings root and sections must be JSON objects");
    }
    return { values: parsed as Record<string, Record<string, unknown>> };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { values: {}, error: new Error(`Cannot read ${path}: ${message}`) };
  }
}

export function writeSettingsFile(path: string, values: Record<string, Record<string, unknown>>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export const setting = {
  boolean(options: boolean | { default: boolean; label?: string; description?: string; order?: number; labels?: { true?: string; false?: string } }, description?: string): SettingDefinition<boolean> {
    if (typeof options === "object") {
      return {
        type: "boolean",
        default: options.default,
        label: options.label,
        description: options.description,
        order: options.order,
        choices: [true, false],
        choiceLabels: { true: options.labels?.true ?? "on", false: options.labels?.false ?? "off" },
      };
    }
    return { type: "boolean", default: options, description, choices: [true, false], choiceLabels: { true: "on", false: "off" } };
  },
  string(options: string | { default: string; label?: string; description?: string; order?: number }, description?: string): SettingDefinition<string> {
    if (typeof options === "object") return { type: "string", default: options.default, label: options.label, description: options.description, order: options.order };
    return { type: "string", default: options, description };
  },
  number(options: number | { default: number; label?: string; description?: string; order?: number; min?: number; max?: number; step?: number }, description?: string): SettingDefinition<number> {
    if (typeof options === "object") {
      return { type: "number", default: options.default, label: options.label, description: options.description, order: options.order, min: options.min, max: options.max, step: options.step };
    }
    return { type: "number", default: options, description };
  },
  enum<const T extends string>(
    options: T | { default: T; choices: readonly (T | SettingChoice<T>)[]; label?: string; description?: string; order?: number },
    choices?: readonly T[],
    description?: string
  ): SettingDefinition<T> {
    if (typeof options === "object") {
      const rawChoices = options.choices.map((choice) => (typeof choice === "object" ? choice.value : choice));
      const choiceLabels: Record<string, string> = {};
      for (const choice of options.choices) if (typeof choice === "object") choiceLabels[String(choice.value)] = choice.label;
      return { type: "enum", default: options.default, choices: rawChoices, choiceLabels, label: options.label, description: options.description, order: options.order };
    }
    return { type: "enum", default: options, choices, description };
  },
};

export function createSettingsRegistry(
  initialValues: Record<string, Record<string, unknown>> = {},
  options: { persistPath?: string | false; loadError?: Error } = {},
) {
  const definitions = new Map<string, SettingsDefinition>();
  const sections = new Map<string, SettingSection>();
  const values = new Map<string, Record<string, unknown>>(Object.entries(initialValues).map(([id, sectionValues]) => [id, { ...sectionValues }]));
  const persistPath = options.persistPath;
  const initialLoadError = options.loadError;

  function ensureSection(plugin: string, target = values) {
    if (!target.has(plugin)) target.set(plugin, {});
    return target.get(plugin)!;
  }

  function valuesObject(source = values): Record<string, Record<string, unknown>> {
    return Object.fromEntries([...source.entries()].map(([id, sectionValues]) => [id, { ...sectionValues }]));
  }

  function assertWritable(): void {
    if (persistPath && initialLoadError) throw initialLoadError;
  }

  function commitUpdates(updates: Array<{ plugin: string; key: string; value: unknown }>): void {
    assertWritable();
    const next = new Map<string, Record<string, unknown>>([...values.entries()].map(([id, sectionValues]) => [id, { ...sectionValues }]));
    for (const update of updates) ensureSection(update.plugin, next)[update.key] = update.value;
    if (persistPath) writeSettingsFile(persistPath, valuesObject(next));
    values.clear();
    for (const [id, sectionValues] of next) values.set(id, sectionValues);
  }

  const registry = {
    register(plugin: string, definition: SettingsDefinition) {
      this.registerSection({ id: plugin, title: labelFromKey(plugin), settings: definition });
    },
    registerSection(section: SettingSection) {
      for (const [key, definition] of Object.entries(section.settings)) {
        if (!baseValidate(definition, definition.default)) throw new Error(`Invalid default value for setting: ${section.id}.${key}`);
      }
      sections.set(section.id, section);
      definitions.set(section.id, section.settings);
      const sectionValues = ensureSection(section.id);
      for (const [key, definition] of Object.entries(section.settings)) {
        if (!baseValidate(definition, sectionValues[key])) sectionValues[key] = definition.default;
      }
    },
    definition(plugin: string) {
      return definitions.get(plugin);
    },
    section(plugin: string) {
      return sections.get(plugin);
    },
    sections() {
      return [...sections.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
    },
    rows() {
      const rows: SettingRow[] = [];
      for (const section of this.sections()) {
        const entries = Object.entries(section.settings).sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0) || a[0].localeCompare(b[0]));
        for (const [key, definition] of entries) rows.push({ section, key, definition, path: `${section.id}.${key}` });
      }
      return rows;
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
      commitUpdates([{ plugin, key, value }]);
    },
    apply(nextValues: Record<string, Record<string, unknown>>) {
      const updates: Array<{ plugin: string; key: string; value: unknown }> = [];
      for (const [plugin, definition] of definitions) {
        const sectionValues = nextValues[plugin];
        if (!sectionValues) continue;
        for (const [key, settingDefinition] of Object.entries(definition)) {
          if (!Object.hasOwn(sectionValues, key)) continue;
          const value = sectionValues[key];
          if (!baseValidate(settingDefinition, value)) throw new Error(`Invalid value for setting: ${plugin}.${key}`);
          updates.push({ plugin, key, value });
        }
      }
      if (updates.length) commitUpdates(updates);
    },
    reset(path: string) {
      const [plugin, key] = path.split(".", 2);
      const definition = definitions.get(plugin)?.[key];
      if (!definition) throw new Error(`Unknown setting: ${path}`);
      commitUpdates([{ plugin, key, value: definition.default }]);
    },
    choices(path: string): SettingChoice[] {
      const [plugin, key] = path.split(".", 2);
      const definition = definitions.get(plugin)?.[key];
      if (!definition) throw new Error(`Unknown setting: ${path}`);
      if (definition.type === "boolean") return [normalizeChoice(true, definition), normalizeChoice(false, definition)];
      return (definition.choices ?? []).map((choice) => normalizeChoice(choice, definition));
    },
    cycle(path: string, direction: 1 | -1 = 1) {
      const choices = this.choices(path);
      if (!choices.length) return false;
      const current = this.get(path);
      const index = Math.max(0, choices.findIndex((choice) => Object.is(choice.value, current)));
      const next = choices[(index + direction + choices.length) % choices.length];
      this.set(path, next.value);
      return true;
    },
    valueLabel(path: string) {
      const current = this.get(path);
      return this.choices(path).find((choice) => Object.is(choice.value, current))?.label ?? String(current);
    },
    settingLabel(row: SettingRow) {
      return row.definition.label ?? labelFromKey(row.key);
    },
    all() {
      return valuesObject();
    },
    loadError() {
      return initialLoadError;
    },
  };

  return registry;
}

export type SettingsRegistry = ReturnType<typeof createSettingsRegistry>;

const GLOBAL_SETTINGS_KEY = Symbol.for("pip-common.settings-registry");

export function getPipSettingsRegistry(): SettingsRegistry {
  const globalState = globalThis as any;
  if (!globalState[GLOBAL_SETTINGS_KEY]) {
    const loaded = readSettingsFile(DEFAULT_SETTINGS_PATH);
    globalState[GLOBAL_SETTINGS_KEY] = createSettingsRegistry(loaded.values, { persistPath: DEFAULT_SETTINGS_PATH, loadError: loaded.error });
  }
  return globalState[GLOBAL_SETTINGS_KEY];
}

export const pipSettings = getPipSettingsRegistry();

export function registerSettingsSection(section: SettingSection): void {
  pipSettings.registerSection(section);
}
