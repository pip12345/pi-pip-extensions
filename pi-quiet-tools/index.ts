import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createFindTool, createGrepTool, createLsTool, createReadTool } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { createLifecycle, listPipToolRegistrations, onPipToolRegistrationChange, registerPipToolFinalizer, registerSettingsSection, setting, settingsFor, themeFg } from "../pip-common/index.ts";

const HOME = homedir();
const SETTINGS_ID = "quiet-tools";
const BUILTIN_QUIET_TOOLS = [
  { name: "read", label: "Read" },
  { name: "grep", label: "Grep" },
  { name: "find", label: "Find" },
  { name: "ls", label: "Ls" },
] as const;

type BuiltinName = (typeof BUILTIN_QUIET_TOOLS)[number]["name"];
type BuiltIns = Record<BuiltinName, ToolDefinition<any, any, any>>;
type BuiltinConfig = {
  name: BuiltinName;
  fallbackPath: string;
  summarizeCall: (args: any) => string;
};

const scopedSettings = settingsFor(SETTINGS_ID);
const toolCache = new Map<string, BuiltIns>();

function createBuiltInTools(cwd: string): BuiltIns {
  return {
    read: createReadTool(cwd),
    grep: createGrepTool(cwd),
    find: createFindTool(cwd),
    ls: createLsTool(cwd),
  };
}

function getBuiltInTools(cwd: string): BuiltIns {
  let tools = toolCache.get(cwd);
  if (!tools) {
    tools = createBuiltInTools(cwd);
    toolCache.set(cwd, tools);
  }
  return tools;
}

function shortenPath(path: unknown, fallback = "."): string {
  const raw = typeof path === "string" && path.length > 0 ? path : fallback;
  return raw.startsWith(HOME) ? `~${raw.slice(HOME.length)}` : raw;
}

function firstText(result: any): string {
  const block = result?.content?.find?.((item: any) => item?.type === "text");
  return block?.type === "text" ? block.text ?? "" : "";
}

const EMPTY_COMPONENT: Component = { render: () => [], invalidate: () => {} };

function expandedOutput(result: any, theme: any): Component {
  const text = firstText(result);
  if (!text.trim()) return EMPTY_COMPONENT;
  return new Text("\n" + text.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n"), 0, 0);
}

function quiet(theme: any, label: string, rest = "", context?: any): Text {
  const expandedWarning = context?.expanded ? ` ${theme.fg("warning", "expanded")}` : "";
  const suffix = rest ? `: ${rest}` : "";
  return new Text(theme.fg("dim", `› ${label}${suffix}`) + expandedWarning, 0, 0);
}

function settingKey(toolName: string): string {
  return toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function isQuietEnabled(toolName: string): boolean {
  if (!scopedSettings.get("enabled", true)) return false;
  return scopedSettings.get(settingKey(toolName), true);
}

function registerQuietSettings(): void {
  const dynamicSettings: Record<string, any> = {};
  for (const tool of BUILTIN_QUIET_TOOLS) {
    dynamicSettings[settingKey(tool.name)] = setting.boolean({ label: tool.label, default: true, description: `Use compact rendering for ${tool.name} tool calls.`, order: 10 });
  }
  let order = 20;
  for (const registration of listPipToolRegistrations()) {
    if (!registration.metadata?.quietCapable || !registration.metadata.compact) continue;
    const label = registration.metadata.label ?? registration.tool.label ?? registration.tool.name;
    dynamicSettings[settingKey(registration.tool.name)] = setting.boolean({ label, default: true, description: `Use compact rendering for ${label}.`, order: order++ });
  }

  registerSettingsSection({
    id: SETTINGS_ID,
    title: "Quiet Tools",
    description: "Compact rendering for selected tool calls.",
    order: 50,
    settings: {
      enabled: setting.boolean({ label: "Enabled", default: true, description: "Enable compact rendering for selected tools.", order: 1 }),
      ...dynamicSettings,
    },
  });
}

function renderCompactPipCall(toolName: string, compact: any) {
  return (args: any, theme: any, context: any) => quiet(theme, toolName, compact.call?.(args) ?? "", context);
}

function renderCompactPipResult(compact: any) {
  return (result: any, options: any, theme: any) => {
    const resultText = compact.result?.(result);
    if (options?.expanded) {
      const expanded = compact.expandedResult?.(result) ?? resultText ?? firstText(result);
      return expanded.trim() ? new Text("\n" + expanded.split("\n").map((line: string) => themeFg(theme, "toolOutput", line)).join("\n"), 0, 0) : EMPTY_COMPONENT;
    }
    if (resultText?.trim()) return new Text(themeFg(theme, "warning", "⚠ ") + themeFg(theme, "muted", resultText), 0, 0);
    return EMPTY_COMPONENT;
  };
}

function registerQuietPipFinalizer(): () => void {
  return registerPipToolFinalizer({
    id: "quiet-tools",
    order: 100,
    finalize({ tool, metadata }) {
      if (!metadata?.quietCapable || !metadata.compact || !isQuietEnabled(tool.name)) return tool;
      return { ...tool, renderShell: "self", renderCall: renderCompactPipCall(tool.name, metadata.compact), renderResult: renderCompactPipResult(metadata.compact) };
    },
  });
}

function renderErrorIfCollapsed(result: any, theme: any): Component {
  const text = firstText(result).trim();
  if (/^(error|access denied|failed)\b/i.test(text)) return new Text(theme.fg("error", text.split("\n")[0] ?? text), 0, 0);
  return EMPTY_COMPONENT;
}

function builtinRenderFallback(name: BuiltinName, kind: "renderCall" | "renderResult", args: any[], fallback: Component): Component {
  return (getBuiltInTools(process.cwd())[name] as any)[kind]?.(...args) ?? fallback;
}

const BUILTIN_CONFIGS: BuiltinConfig[] = [
  {
    name: "read",
    fallbackPath: "",
    summarizeCall(args) {
      const path = shortenPath(args.path, "");
      const start = typeof args.offset === "number" ? args.offset : undefined;
      const end = typeof args.limit === "number" ? (start ?? 1) + args.limit - 1 : undefined;
      const range = start || end ? `:${start ?? 1}${end ? `-${end}` : ""}` : "";
      return `${path}${range}`;
    },
  },
  {
    name: "grep",
    fallbackPath: ".",
    summarizeCall(args) {
      const pattern = args.literal ? String(args.pattern ?? "") : `/${String(args.pattern ?? "")}/`;
      const bits = [pattern, `in ${shortenPath(args.path, ".")}`];
      if (args.glob) bits.push(String(args.glob));
      if (args.ignoreCase) bits.push("-i");
      return bits.join(" ");
    },
  },
  { name: "find", fallbackPath: ".", summarizeCall: (args) => `${String(args.pattern ?? "")} in ${shortenPath(args.path, ".")}` },
  { name: "ls", fallbackPath: ".", summarizeCall: (args) => shortenPath(args.path, ".") },
];

function registerQuietBuiltin(pi: ExtensionAPI, config: BuiltinConfig): void {
  const builtin = getBuiltInTools(process.cwd())[config.name];
  pi.registerTool({
    name: config.name,
    label: config.name,
    description: builtin.description,
    parameters: builtin.parameters,
    renderShell: isQuietEnabled(config.name) ? "self" : "default",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd ?? process.cwd())[config.name].execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      if (!isQuietEnabled(config.name)) return builtinRenderFallback(config.name, "renderCall", [args, theme, context], quiet(theme, config.name, "", context));
      return quiet(theme, config.name, config.summarizeCall(args), context);
    },
    renderResult(result, { expanded }, theme, context) {
      if (!isQuietEnabled(config.name)) return builtinRenderFallback(config.name, "renderResult", [result, { expanded }, theme, context], expandedOutput(result, theme));
      if (!expanded) return renderErrorIfCollapsed(result, theme);
      return expandedOutput(result, theme);
    },
  });
}

export default function (pi: ExtensionAPI) {
  const lifecycle = createLifecycle();
  registerQuietSettings();
  lifecycle.add(onPipToolRegistrationChange(registerQuietSettings));
  lifecycle.add(registerQuietPipFinalizer());
  pi.on("session_shutdown", async () => { await lifecycle.disposeAll(); });
  for (const config of BUILTIN_CONFIGS) registerQuietBuiltin(pi, config);
}
