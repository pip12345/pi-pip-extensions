import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { createLifecycle, firstResultText, registerPipToolFinalizer, registerSettingsSection, setting, settingsFor, themeFg, safeTruncateToWidth, type ScopedSettings } from "../pip-common/index.ts";
import { safeCachedComponent, themeBold, toolShellComponent } from "./src/shell.ts";
import { renderSplitEditDiff, renderUnifiedEditDiff } from "./src/split-diff.ts";

const HOME = homedir();
const SETTINGS_ID = "tool-ui";

type BuiltinName = "read" | "grep" | "find" | "ls" | "edit";
type BuiltIns = Record<BuiltinName, ToolDefinition<any, any, any>>;
type SlotAdapter = {
  tool: BuiltinName;
  shell?: "self" | "default";
  renderCall?: NonNullable<ToolDefinition<any, any, any>["renderCall"]>;
  renderResult?: NonNullable<ToolDefinition<any, any, any>["renderResult"]>;
};

const toolCache = new Map<string, BuiltIns>();
const COMPACT_PIP_TOOLS = new Set(["todo_write", "todo_update", "todo_read", "tiny-mcp"]);

function createBuiltInTools(cwd: string): BuiltIns {
  return {
    read: createReadToolDefinition(cwd),
    grep: createGrepToolDefinition(cwd),
    find: createFindToolDefinition(cwd),
    ls: createLsToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
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

function toolUiEnabled(settings: ScopedSettings): boolean {
  return settings.get("enabled", true);
}

function editDiffEnabled(settings: ScopedSettings): boolean {
  return toolUiEnabled(settings) && settings.get("editDiff", true);
}

function builtinRenderFallback(name: BuiltinName, kind: "renderCall" | "renderResult", args: any[], fallback: Component): Component {
  return (getBuiltInTools(process.cwd())[name] as any)[kind]?.(...args) ?? fallback;
}

function collapsedError(result: any): string {
  const firstLine = firstResultText(result).trim().split(/\r?\n/, 1)[0] || "Tool failed";
  return safeTruncateToWidth(firstLine, 200);
}

function renderErrorIfCollapsed(result: any, theme: any, isError: boolean): Component {
  return isError ? new Text(themeFg(theme, "error", collapsedError(result)), 0, 0) : EMPTY_COMPONENT;
}

function quietCall(label: string, summarize: (args: any) => string) {
  return (args: any, theme: any, context: any) => toolLine(theme, label, summarize(args), context);
}

function quietResult(settings: ScopedSettings, tool: BuiltinName) {
  return (result: any, { expanded }: any, theme: any, context: any) => {
    if (!toolUiEnabled(settings)) return builtinRenderFallback(tool, "renderResult", [result, { expanded }, theme, context], expandedOutput(result, theme));
    if (!expanded) return renderErrorIfCollapsed(result, theme, Boolean(context?.isError));
    return expandedOutput(result, theme);
  };
}

function editDiffComponentForDiff(settings: ScopedSettings, diff: unknown, theme: any): Component | undefined {
  if (typeof diff !== "string" || !diff.trim()) return undefined;
  const component: Component = {
    render(width: number) {
      const layout = settings.get<string>("diffLayout", "auto");
      const useSplit = layout === "split" || (layout === "auto" && width >= 120);
      const maxLines = 80;
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

function reusableEditResultComponent(settings: ScopedSettings, result: any, theme: any, lastComponent?: Component): Component | undefined {
  const diff = result?.details?.diff;
  if (typeof diff !== "string" || !diff.trim()) return undefined;
  const last = lastComponent as any;
  if (last?.[EDIT_DIFF_COMPONENT] && last?.[EDIT_DIFF_SOURCE] === diff) return lastComponent;
  const split = editDiffComponentForDiff(settings, diff, theme);
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

function makeQuietAdapter(settings: ScopedSettings, tool: BuiltinName, summarize: (args: any) => string): SlotAdapter {
  return {
    tool,
    shell: "self",
    renderCall(args, theme, context) {
      if (!toolUiEnabled(settings)) return safeCachedComponent(builtinRenderFallback(tool, "renderCall", [args, theme, context], toolLine(theme, tool, "", context)));
      return safeCachedComponent(quietCall(tool, summarize)(args, theme, context));
    },
    renderResult(result, options, theme, context) {
      return safeCachedComponent(quietResult(settings, tool)(result, options, theme, context));
    },
  };
}

function createBuiltinAdapters(settings: ScopedSettings): SlotAdapter[] {
  return [
  makeQuietAdapter(settings, "read", (args) => {
    const path = shortenPath(args.path, "");
    const start = typeof args.offset === "number" ? args.offset : undefined;
    const end = typeof args.limit === "number" ? (start ?? 1) + args.limit - 1 : undefined;
    const range = start || end ? `:${start ?? 1}${end ? `-${end}` : ""}` : "";
    return `${path}${range}`;
  }),
  makeQuietAdapter(settings, "grep", (args) => {
    const pattern = args.literal ? String(args.pattern ?? "") : `/${String(args.pattern ?? "")}/`;
    const bits = [pattern, `in ${shortenPath(args.path, ".")}`];
    if (args.glob) bits.push(String(args.glob));
    if (args.ignoreCase) bits.push("-i");
    return bits.join(" ");
  }),
  makeQuietAdapter(settings, "find", (args) => `${String(args.pattern ?? "")} in ${shortenPath(args.path, ".")}`),
  makeQuietAdapter(settings, "ls", (args) => shortenPath(args.path, ".")),
  {
    tool: "edit",
    shell: "self",
    renderCall(args, theme, context) {
      if (!editDiffEnabled(settings)) return safeCachedComponent(builtinRenderFallback("edit", "renderCall", [args, theme, context], toolLine(theme, "edit", shortenPath((args as any)?.path, ""), context)));
      return editCallComponent(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      if (!editDiffEnabled(settings)) return safeCachedComponent(builtinRenderFallback("edit", "renderResult", [result, options, theme, context], expandedOutput(result, theme)));
      const renderedDiff = context?.isError ? undefined : reusableEditResultComponent(settings, result, theme, context?.lastComponent);
      return renderedDiff ?? safeCachedComponent(renderErrorIfCollapsed(result, theme, Boolean(context?.isError)));
    },
  },
  ];
}

function renderDisplayPipCall(toolName: string, display: any) {
  return (args: any, theme: any, context: any) => toolLine(theme, toolName, display.call?.(args) ?? "", context);
}

function renderDisplayPipResult(display: any) {
  return (result: any, options: any, theme: any, context?: any) => {
    const rawText = firstResultText(result);
    const isError = Boolean(context?.isError);
    const resultText = display.result?.(result);
    if (options?.expanded) {
      const expanded = display.expandedResult?.(result) ?? resultText ?? rawText;
      return textLines(expanded, theme);
    }
    if (display.hideSuccessfulResult && !isError) return EMPTY_COMPONENT;
    const collapsed = isError ? collapsedError(result) : resultText;
    if (collapsed?.trim()) return new Text(themeFg(theme, isError ? "error" : "muted", isError ? collapsed : safeTruncateToWidth(collapsed, 200)), 0, 0);
    return EMPTY_COMPONENT;
  };
}

function registerToolUiPipFinalizer(pi: ExtensionAPI, settings: ScopedSettings): () => void {
  return registerPipToolFinalizer(pi, {
    id: "tool-ui",
    order: 100,
    finalize({ tool, metadata }) {
      if (!COMPACT_PIP_TOOLS.has(tool.name) || !metadata?.display || !toolUiEnabled(settings)) return tool;
      return { ...tool, renderShell: "self", renderCall: renderDisplayPipCall(tool.name, metadata.display), renderResult: renderDisplayPipResult(metadata.display) };
    },
  });
}

function registerToolUiSettings(pi: ExtensionAPI): void {
  registerSettingsSection(pi, {
    id: SETTINGS_ID,
    title: "Tool UI",
    description: "Unified rendering for tool calls and results.",
    order: 50,
    settings: {
      enabled: setting.boolean({ label: "Enabled", default: true, description: "Enable Tool UI rendering adapters.", order: 1, requiresReload: true }),
      diffLayout: setting.enum({ label: "Diff layout", default: "auto", choices: ["auto", "split", "unified"] as const, description: "Preferred layout for edit diffs.", order: 2 }),
      editDiff: setting.boolean({ label: "Edit diff", default: true, description: "Render edit results with Tool UI-owned split or unified diffs.", order: 3, requiresReload: true }),
    },
  });
}

function registerBuiltInAdapter(pi: ExtensionAPI, adapter: SlotAdapter, settings: ScopedSettings): void {
  const builtin = getBuiltInTools(process.cwd())[adapter.tool];
  const tool: ToolDefinition<any, any, any> = {
    ...builtin,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd ?? process.cwd())[adapter.tool].execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
  if (adapter.shell) tool.renderShell = adapter.tool === "edit" ? (editDiffEnabled(settings) ? adapter.shell : "default") : (toolUiEnabled(settings) ? adapter.shell : "default");
  if (adapter.renderCall) tool.renderCall = adapter.renderCall;
  if (adapter.renderResult) tool.renderResult = adapter.renderResult;
  pi.registerTool(tool);
}

export default function (pi: ExtensionAPI) {
  const lifecycle = createLifecycle();
  const settings = settingsFor(pi, SETTINGS_ID);
  const adapters = createBuiltinAdapters(settings);
  registerToolUiSettings(pi);
  lifecycle.add(registerToolUiPipFinalizer(pi, settings));
  pi.on("session_shutdown", async () => { await lifecycle.disposeAll(); });
  for (const adapter of adapters) registerBuiltInAdapter(pi, adapter, settings);
}
