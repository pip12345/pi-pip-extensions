import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { createLifecycle, firstResultText, listPipToolRegistrations, onPipToolRegistrationChange, registerPipToolFinalizer, registerSettingsSection, setting, settingsFor, themeFg, safeTruncateToWidth } from "pip-common";
import { safeCachedComponent, themeBold, toolShellComponent } from "./src/shell.ts";
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

const EMPTY_COMPONENT: Component = { render: () => [], invalidate: () => {} };
const EDIT_DIFF_COMPONENT = Symbol("tool-ui.editDiffComponent");
const EDIT_DIFF_SOURCE = Symbol("tool-ui.editDiffSource");

function textLines(text: string, theme: any): Component {
  if (!text.trim()) return EMPTY_COMPONENT;
  return new Text("\n" + text.split("\n").map((line) => themeFg(theme, "toolOutput", line)).join("\n"), 0, 0);
}

function expandedOutput(result: any, theme: any): Component {
  return textLines(firstResultText(result), theme);
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

function renderErrorIfCollapsed(result: any, theme: any): Component {
  const text = firstResultText(result).trim();
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
  const component: Component = {
    render(width: number) {
      const layout = scopedSettings.get<string>("diffLayout", "auto");
      const minWidth = Number(scopedSettings.get("diffSplitMinWidth", 120));
      const maxLines = Number(scopedSettings.get("diffMaxLines", 80));
      const useSplit = layout === "split" || (layout === "auto" && width >= minWidth);
      if (useSplit) {
        const split = renderSplitEditDiff(diff, width, theme, { maxLines });
        if (split) return split;
      }
      return renderUnifiedEditDiff(diff, width, theme, { maxLines });
    },
    invalidate() {},
  };
  (component as any)[EDIT_DIFF_COMPONENT] = true;
  (component as any)[EDIT_DIFF_SOURCE] = diff;
  return component;
}

function reusableEditResultComponent(result: any, theme: any, lastComponent?: Component): Component | undefined {
  const diff = result?.details?.diff;
  if (typeof diff !== "string" || !diff.trim()) return undefined;
  const last = lastComponent as any;
  if (last?.[EDIT_DIFF_COMPONENT] && last?.[EDIT_DIFF_SOURCE] === diff) return lastComponent;
  const split = editDiffComponentForDiff(diff, theme);
  return split ? toolShellComponent(split, theme, { bg: "toolSuccessBg", role: "joinedResult" }) : undefined;
}

function toolShellStatus(context: any): "pending" | "success" | "error" {
  if (context?.isError) return "error";
  return context?.isPartial === false ? "success" : "pending";
}

function editCallComponent(args: any, theme: any, context?: any): Component {
  const path = shortenPath(args?.path, "");
  const count = Array.isArray(args?.edits) ? args.edits.length : undefined;
  const countText = count === undefined ? "" : ` ${themeFg(theme, "muted", `${count} edit${count === 1 ? "" : "s"}`)}`;
  const pathText = path ? ` ${themeFg(theme, "muted", path)}` : "";
  const line = `${themeFg(theme, "toolTitle", themeBold(theme, "edit"))}${pathText}${countText}`;
  return toolShellComponent({ render: (width: number) => [safeTruncateToWidth(line, width)], invalidate() {} }, theme, { role: "call", status: toolShellStatus(context) });
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
      if (!adapterEnabled(key)) return safeCachedComponent(builtinRenderFallback(tool, "renderCall", [args, theme, context], toolLine(theme, tool, "", context)));
      return safeCachedComponent(quietCall(tool, summarize)(args, theme, context));
    },
    renderResult(result, options, theme, context) {
      return safeCachedComponent(quietResult(tool)(result, options, theme, context));
    },
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
    settingDescription: "Render edit results with Tool UI-owned split diffs using renderShell:self instead of patching Pi's built-in edit preview internals.",
    shell: "self",
    renderCall(args, theme, context) {
      if (!adapterEnabled("editDiff")) return safeCachedComponent(builtinRenderFallback("edit", "renderCall", [args, theme, context], toolLine(theme, "edit", shortenPath((args as any)?.path, ""), context)));
      return editCallComponent(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      if (!adapterEnabled("editDiff")) return safeCachedComponent(builtinRenderFallback("edit", "renderResult", [result, options, theme, context], expandedOutput(result, theme)));
      const renderedDiff = reusableEditResultComponent(result, theme, context?.lastComponent);
      return renderedDiff ?? safeCachedComponent(renderErrorIfCollapsed(result, theme));
    },
  },
];

function renderDisplayPipCall(toolName: string, display: any) {
  return (args: any, theme: any, context: any) => toolLine(theme, toolName, display.call?.(args) ?? "", context);
}

function renderDisplayPipResult(display: any) {
  return (result: any, options: any, theme: any, context?: any) => {
    const rawText = firstResultText(result);
    const isError = context?.isError || /^(error|access denied|failed)\b/i.test(rawText.trim());
    const resultText = display.result?.(result);
    if (options?.expanded) {
      const expanded = display.expandedResult?.(result) ?? resultText ?? rawText;
      return textLines(expanded, theme);
    }
    if (display.hideSuccessfulResult && !isError) return EMPTY_COMPONENT;
    const collapsed = resultText ?? (isError ? rawText.split("\n")[0] : undefined);
    if (collapsed?.trim()) return new Text(themeFg(theme, isError ? "error" : "muted", collapsed), 0, 0);
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
    dynamicSettings[adapter.settingKey] = setting.boolean({ label: adapter.label, default: true, description: adapter.settingDescription, order: 10, requiresReload: true });
  }
  let order = 20;
  for (const registration of listPipToolRegistrations()) {
    if (!COMPACT_PIP_TOOLS.has(registration.tool.name) || !registration.metadata?.display) continue;
    const label = registration.metadata.label ?? registration.tool.label ?? registration.tool.name;
    dynamicSettings[settingKey(registration.tool.name)] = setting.boolean({ label, default: true, description: `Use compact Tool UI rendering for ${label}.`, order: order++, requiresReload: true });
  }

  registerSettingsSection({
    id: SETTINGS_ID,
    title: "Tool UI",
    description: "Unified rendering for tool calls and results.",
    order: 50,
    settings: {
      enabled: setting.boolean({ label: "Enabled", default: true, description: "Enable Tool UI rendering adapters.", order: 1, requiresReload: true }),
      diffLayout: setting.enum({ label: "Diff layout", default: "auto", choices: ["auto", "split", "unified"] as const, description: "Preferred layout for edit diffs.", order: 2 }),
      diffSplitMinWidth: setting.number({ label: "Split diff width", default: 120, min: 80, max: 240, step: 10, description: "Minimum terminal width before auto layout uses side-by-side edit diffs.", order: 3 }),
      diffMaxLines: setting.number({ label: "Diff max lines", default: 80, min: 20, max: 1000, step: 20, description: "Maximum edit diff lines shown in Tool UI rendering.", order: 4 }),
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
