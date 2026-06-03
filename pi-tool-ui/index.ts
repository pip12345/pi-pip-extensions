import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createEditTool, createEditToolDefinition, createFindTool, createGrepTool, createLsTool, createReadTool } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { createLifecycle, listPipToolRegistrations, onPipToolRegistrationChange, registerPipToolFinalizer, registerSettingsSection, setting, settingsFor, themeFg } from "../pip-common/index.ts";
import { renderSplitEditDiff, renderUnifiedEditDiff } from "./src/split-diff.ts";

const HOME = homedir();
const SETTINGS_ID = "tool-ui";

type BuiltinName = "read" | "grep" | "find" | "ls" | "edit";
type BuiltIns = Record<BuiltinName, ToolDefinition<any, any, any>>;
type SlotAdapter = {
  id: string;
  tool: BuiltinName;
  label: string;
  settingKey: string;
  settingDescription: string;
  shell?: "self" | "default";
  renderCall?: NonNullable<ToolDefinition<any, any, any>["renderCall"]>;
  renderResult?: NonNullable<ToolDefinition<any, any, any>["renderResult"]>;
};

const scopedSettings = settingsFor(SETTINGS_ID);
const toolCache = new Map<string, BuiltIns>();
const COMPACT_PIP_TOOLS = new Set(["todo_write", "todo_update", "todo_read", "tiny-mcp"]);

function createBuiltInTools(cwd: string): BuiltIns {
  return {
    read: createReadTool(cwd),
    grep: createGrepTool(cwd),
    find: createFindTool(cwd),
    ls: createLsTool(cwd),
    edit: createEditTool(cwd),
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

function textLines(text: string, theme: any): Component {
  if (!text.trim()) return EMPTY_COMPONENT;
  return new Text("\n" + text.split("\n").map((line) => themeFg(theme, "toolOutput", line)).join("\n"), 0, 0);
}

function expandedOutput(result: any, theme: any): Component {
  return textLines(firstText(result), theme);
}

function toolLine(theme: any, label: string, rest = "", context?: any): Text {
  const expandedWarning = context?.expanded ? ` ${themeFg(theme, "warning", "expanded")}` : "";
  const suffix = rest ? `: ${rest}` : "";
  return new Text(themeFg(theme, "dim", `› ${label}${suffix}`) + expandedWarning, 0, 0);
}

function settingKey(toolName: string): string {
  return toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function adapterEnabled(key: string): boolean {
  if (!scopedSettings.get("enabled", true)) return false;
  return scopedSettings.get(key, true);
}

function builtinRenderFallback(name: BuiltinName, kind: "renderCall" | "renderResult", args: any[], fallback: Component): Component {
  return (getBuiltInTools(process.cwd())[name] as any)[kind]?.(...args) ?? fallback;
}

function builtinForContext(name: BuiltinName, context: any): ToolDefinition<any, any, any> {
  return getBuiltInTools(context?.cwd ?? process.cwd())[name];
}

function renderErrorIfCollapsed(result: any, theme: any): Component {
  const text = firstText(result).trim();
  if (/^(error|access denied|failed)\b/i.test(text)) return new Text(themeFg(theme, "error", text.split("\n")[0] ?? text), 0, 0);
  return EMPTY_COMPONENT;
}

function quietCall(label: string, summarize: (args: any) => string) {
  return (args: any, theme: any, context: any) => toolLine(theme, label, summarize(args), context);
}

function quietResult(tool: BuiltinName) {
  return (result: any, { expanded }: any, theme: any, context: any) => {
    if (!adapterEnabled(settingKey(tool))) return builtinRenderFallback(tool, "renderResult", [result, { expanded }, theme, context], expandedOutput(result, theme));
    if (!expanded) return renderErrorIfCollapsed(result, theme);
    return expandedOutput(result, theme);
  };
}

function editDiffComponentForDiff(diff: unknown, theme: any): Component | undefined {
  if (typeof diff !== "string" || !diff.trim()) return undefined;
  return {
    render(width: number) {
      const layout = scopedSettings.get<string>("diffLayout", "auto");
      const minWidth = Number(scopedSettings.get("diffSplitMinWidth", 120));
      const maxLines = Number(scopedSettings.get("diffMaxLines", 80));
      const useSplit = layout === "split" || (layout === "auto" && width >= minWidth);
      if (useSplit) {
        const split = renderSplitEditDiff(diff, width, theme, { maxLines });
        if (split) return split;
      }
      return renderUnifiedEditDiff(diff, theme, { maxLines });
    },
    invalidate() {},
  };
}

function editDiffComponent(result: any, theme: any): Component | undefined {
  return editDiffComponentForDiff(result?.details?.diff, theme);
}

function replaceEditCallDiff(context: any, component: Component): boolean {
  const callComponent = context?.state?.callComponent as any;
  const children = callComponent?.children;
  if (!Array.isArray(children) || children.length < 3) return false;
  children[children.length - 1] = component;
  callComponent.invalidate?.();
  return true;
}

function makeQuietAdapter(tool: BuiltinName, label: string, summarize: (args: any) => string): SlotAdapter {
  const key = settingKey(tool);
  return {
    id: `quiet:${tool}`,
    tool,
    label,
    settingKey: key,
    settingDescription: `Use compact rendering for ${tool} tool calls.`,
    shell: "self",
    renderCall(args, theme, context) {
      if (!adapterEnabled(key)) return builtinRenderFallback(tool, "renderCall", [args, theme, context], toolLine(theme, tool, "", context));
      return quietCall(tool, summarize)(args, theme, context);
    },
    renderResult: quietResult(tool),
  };
}

const BUILTIN_ADAPTERS: SlotAdapter[] = [
  makeQuietAdapter("read", "Read", (args) => {
    const path = shortenPath(args.path, "");
    const start = typeof args.offset === "number" ? args.offset : undefined;
    const end = typeof args.limit === "number" ? (start ?? 1) + args.limit - 1 : undefined;
    const range = start || end ? `:${start ?? 1}${end ? `-${end}` : ""}` : "";
    return `${path}${range}`;
  }),
  makeQuietAdapter("grep", "Grep", (args) => {
    const pattern = args.literal ? String(args.pattern ?? "") : `/${String(args.pattern ?? "")}/`;
    const bits = [pattern, `in ${shortenPath(args.path, ".")}`];
    if (args.glob) bits.push(String(args.glob));
    if (args.ignoreCase) bits.push("-i");
    return bits.join(" ");
  }),
  makeQuietAdapter("find", "Find", (args) => `${String(args.pattern ?? "")} in ${shortenPath(args.path, ".")}`),
  makeQuietAdapter("ls", "Ls", (args) => shortenPath(args.path, ".")),
  {
    id: "edit:split-result",
    tool: "edit",
    label: "Edit diff",
    settingKey: "editDiff",
    settingDescription: "Render edit results with Tool UI split diffs while preserving Pi's built-in edit call/preview renderer.",
    renderCall(args, theme, context) {
      const builtin = createEditToolDefinition(context?.cwd ?? process.cwd()).renderCall?.(args as any, theme, context as any) ?? EMPTY_COMPONENT;
      if (!adapterEnabled("editDiff")) return builtin;
      const split = editDiffComponentForDiff(context?.state?.callComponent?.preview?.diff, theme);
      if (split) replaceEditCallDiff(context, split);
      return builtin;
    },
    renderResult(result, options, theme, context) {
      let builtin = EMPTY_COMPONENT;
      try {
        builtin = createEditToolDefinition(context?.cwd ?? process.cwd()).renderResult?.(result as any, options, theme, context as any) ?? EMPTY_COMPONENT;
      } catch {
        builtin = EMPTY_COMPONENT;
      }
      if (!adapterEnabled("editDiff")) return builtin;
      const split = editDiffComponent(result, theme);
      if (!split) return builtin;
      // Pi's built-in edit renderer owns the live call preview and updates it with
      // the final diff in renderResult. Replace that preview body with the split
      // renderer instead of rendering a second diff in the result slot.
      return replaceEditCallDiff(context, split) ? builtin : split;
    },
  },
];

function renderDisplayPipCall(toolName: string, display: any) {
  return (args: any, theme: any, context: any) => toolLine(theme, toolName, display.call?.(args) ?? "", context);
}

function renderDisplayPipResult(display: any) {
  return (result: any, options: any, theme: any) => {
    const resultText = display.result?.(result);
    if (options?.expanded) {
      const expanded = display.expandedResult?.(result) ?? resultText ?? firstText(result);
      return textLines(expanded, theme);
    }
    if (resultText?.trim()) return new Text(themeFg(theme, "warning", "⚠ ") + themeFg(theme, "muted", resultText), 0, 0);
    return EMPTY_COMPONENT;
  };
}

function registerToolUiPipFinalizer(): () => void {
  return registerPipToolFinalizer({
    id: "tool-ui",
    order: 100,
    finalize({ tool, metadata }) {
      if (!COMPACT_PIP_TOOLS.has(tool.name) || !metadata?.display || !adapterEnabled(settingKey(tool.name))) return tool;
      return { ...tool, renderShell: "self", renderCall: renderDisplayPipCall(tool.name, metadata.display), renderResult: renderDisplayPipResult(metadata.display) };
    },
  });
}

function registerToolUiSettings(): void {
  const dynamicSettings: Record<string, any> = {};
  for (const adapter of BUILTIN_ADAPTERS) {
    dynamicSettings[adapter.settingKey] = setting.boolean({ label: adapter.label, default: true, description: adapter.settingDescription, order: 10 });
  }
  let order = 20;
  for (const registration of listPipToolRegistrations()) {
    if (!COMPACT_PIP_TOOLS.has(registration.tool.name) || !registration.metadata?.display) continue;
    const label = registration.metadata.label ?? registration.tool.label ?? registration.tool.name;
    dynamicSettings[settingKey(registration.tool.name)] = setting.boolean({ label, default: true, description: `Use compact Tool UI rendering for ${label}.`, order: order++ });
  }

  registerSettingsSection({
    id: SETTINGS_ID,
    title: "Tool UI",
    description: "Unified rendering for tool calls and results.",
    order: 50,
    settings: {
      enabled: setting.boolean({ label: "Enabled", default: true, description: "Enable Tool UI rendering adapters.", order: 1 }),
      preset: setting.enum({ label: "Preset", default: "quiet", choices: ["quiet", "balanced", "verbose"] as const, description: "Default display density for tool calls and results.", order: 2 }),
      diffLayout: setting.enum({ label: "Diff layout", default: "auto", choices: ["auto", "split", "unified"] as const, description: "Preferred layout for edit diffs.", order: 3 }),
      diffSplitMinWidth: setting.number({ label: "Split diff width", default: 120, min: 80, max: 240, step: 10, description: "Minimum terminal width before auto layout uses side-by-side edit diffs.", order: 4 }),
      diffMaxLines: setting.number({ label: "Diff max lines", default: 80, min: 20, max: 1000, step: 20, description: "Maximum edit diff lines shown in Tool UI rendering.", order: 5 }),
      ...dynamicSettings,
    },
  });
}

function registerBuiltInAdapter(pi: ExtensionAPI, adapter: SlotAdapter): void {
  const builtin = getBuiltInTools(process.cwd())[adapter.tool];
  const tool: ToolDefinition<any, any, any> = {
    name: builtin.name,
    label: builtin.label,
    description: builtin.description,
    parameters: builtin.parameters,
    prepareArguments: builtin.prepareArguments,
    executionMode: builtin.executionMode,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd ?? process.cwd())[adapter.tool].execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
  if (adapter.shell) tool.renderShell = adapterEnabled(adapter.settingKey) ? adapter.shell : "default";
  if (adapter.renderCall) tool.renderCall = adapter.renderCall;
  if (adapter.renderResult) tool.renderResult = adapter.renderResult;
  pi.registerTool(tool);
}

export default function (pi: ExtensionAPI) {
  const lifecycle = createLifecycle();
  registerToolUiSettings();
  lifecycle.add(onPipToolRegistrationChange(registerToolUiSettings));
  lifecycle.add(registerToolUiPipFinalizer());
  pi.on("session_shutdown", async () => { await lifecycle.disposeAll(); });
  for (const adapter of BUILTIN_ADAPTERS) registerBuiltInAdapter(pi, adapter);
}
