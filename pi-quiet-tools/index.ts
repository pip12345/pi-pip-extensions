import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { listPipToolRegistrations, onPipToolRegistrationChange, pipSettings, registerPipToolFinalizer, registerSettingsSection, setting, themeFg } from "pip-common";

const HOME = homedir();
const SETTINGS_ID = "quiet-tools";
const BUILTIN_QUIET_TOOLS = [
  { name: "read", label: "Read" },
  { name: "grep", label: "Grep" },
  { name: "find", label: "Find" },
  { name: "ls", label: "Ls" },
] as const;
type BuiltIns = ReturnType<typeof createBuiltInTools>;
const toolCache = new Map<string, BuiltIns>();

function createBuiltInTools(cwd: string) {
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

const EMPTY_COMPONENT: Component = {
  render: () => [],
  invalidate: () => {},
};

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

function settingValue<T>(key: string, fallback: T): T {
  try {
    return pipSettings.get<T>(`${SETTINGS_ID}.${key}`);
  } catch {
    return fallback;
  }
}

function isQuietEnabled(toolName: string): boolean {
  if (!settingValue("enabled", true)) return false;
  return settingValue(settingKey(toolName), true);
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
    if (compact.hideSuccessfulResult) return EMPTY_COMPONENT;
    return EMPTY_COMPONENT;
  };
}

function registerQuietPipFinalizer(): void {
  registerPipToolFinalizer({
    id: "quiet-tools",
    order: 100,
    finalize({ tool, metadata }) {
      if (!metadata?.quietCapable || !metadata.compact || !isQuietEnabled(tool.name)) return tool;
      return {
        ...tool,
        renderShell: "self",
        renderCall: renderCompactPipCall(tool.name, metadata.compact),
        renderResult: renderCompactPipResult(metadata.compact),
      };
    },
  });
}

function renderErrorIfCollapsed(result: any, theme: any): Component {
  const text = firstText(result).trim();
  if (/^(error|access denied|failed)\b/i.test(text)) {
    return new Text(theme.fg("error", text.split("\n")[0] ?? text), 0, 0);
  }
  return EMPTY_COMPONENT;
}

export default function (pi: ExtensionAPI) {
  registerQuietSettings();
  onPipToolRegistrationChange(registerQuietSettings);
  registerQuietPipFinalizer();
  pi.registerTool({
    name: "read",
    label: "read",
    description: getBuiltInTools(process.cwd()).read.description,
    parameters: getBuiltInTools(process.cwd()).read.parameters,
    renderShell: isQuietEnabled("read") ? "self" : "default",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      if (!isQuietEnabled("read")) return (getBuiltInTools(process.cwd()).read as any).renderCall?.(args, theme, context) ?? quiet(theme, "read", "", context);
      const path = shortenPath(args.path, "");
      const start = typeof args.offset === "number" ? args.offset : undefined;
      const end = typeof args.limit === "number" ? (start ?? 1) + args.limit - 1 : undefined;
      const range = start || end ? `:${start ?? 1}${end ? `-${end}` : ""}` : "";
      return quiet(theme, "read", `${path}${range}`, context);
    },

    renderResult(result, { expanded }, theme, context) {
      if (!isQuietEnabled("read")) return (getBuiltInTools(process.cwd()).read as any).renderResult?.(result, { expanded }, theme, context) ?? expandedOutput(result, theme);
      if (!expanded) return renderErrorIfCollapsed(result, theme);
      return expandedOutput(result, theme);
    },
  });

  pi.registerTool({
    name: "grep",
    label: "grep",
    description: getBuiltInTools(process.cwd()).grep.description,
    parameters: getBuiltInTools(process.cwd()).grep.parameters,
    renderShell: isQuietEnabled("grep") ? "self" : "default",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).grep.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      if (!isQuietEnabled("grep")) return (getBuiltInTools(process.cwd()).grep as any).renderCall?.(args, theme, context) ?? quiet(theme, "grep", "", context);
      const pattern = args.literal ? String(args.pattern ?? "") : `/${String(args.pattern ?? "")}/`;
      const path = shortenPath(args.path, ".");
      const bits = [pattern, `in ${path}`];
      if (args.glob) bits.push(String(args.glob));
      if (args.ignoreCase) bits.push("-i");
      return quiet(theme, "grep", bits.join(" "), context);
    },

    renderResult(result, { expanded }, theme, context) {
      if (!isQuietEnabled("grep")) return (getBuiltInTools(process.cwd()).grep as any).renderResult?.(result, { expanded }, theme, context) ?? expandedOutput(result, theme);
      if (!expanded) return renderErrorIfCollapsed(result, theme);
      return expandedOutput(result, theme);
    },
  });

  pi.registerTool({
    name: "find",
    label: "find",
    description: getBuiltInTools(process.cwd()).find.description,
    parameters: getBuiltInTools(process.cwd()).find.parameters,
    renderShell: isQuietEnabled("find") ? "self" : "default",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      if (!isQuietEnabled("find")) return (getBuiltInTools(process.cwd()).find as any).renderCall?.(args, theme, context) ?? quiet(theme, "find", "", context);
      const pattern = String(args.pattern ?? "");
      const path = shortenPath(args.path, ".");
      return quiet(theme, "find", `${pattern} in ${path}`, context);
    },

    renderResult(result, { expanded }, theme, context) {
      if (!isQuietEnabled("find")) return (getBuiltInTools(process.cwd()).find as any).renderResult?.(result, { expanded }, theme, context) ?? expandedOutput(result, theme);
      if (!expanded) return renderErrorIfCollapsed(result, theme);
      return expandedOutput(result, theme);
    },
  });

  pi.registerTool({
    name: "ls",
    label: "ls",
    description: getBuiltInTools(process.cwd()).ls.description,
    parameters: getBuiltInTools(process.cwd()).ls.parameters,
    renderShell: isQuietEnabled("ls") ? "self" : "default",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).ls.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      if (!isQuietEnabled("ls")) return (getBuiltInTools(process.cwd()).ls as any).renderCall?.(args, theme, context) ?? quiet(theme, "ls", "", context);
      return quiet(theme, "ls", shortenPath(args.path, "."), context);
    },

    renderResult(result, { expanded }, theme, context) {
      if (!isQuietEnabled("ls")) return (getBuiltInTools(process.cwd()).ls as any).renderResult?.(result, { expanded }, theme, context) ?? expandedOutput(result, theme);
      if (!expanded) return renderErrorIfCollapsed(result, theme);
      return expandedOutput(result, theme);
    },
  });
}
