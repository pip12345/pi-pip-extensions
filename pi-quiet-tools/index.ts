import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ToolExecutionComponent,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

const HOME = homedir();
const QUIET_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const PATCH_KEY = Symbol.for("pi-quiet-tools.tight-tool-render-patch");

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

function quiet(theme: any, label: string, rest: string): Text {
  return new Text(theme.fg("dim", `› ${label}: ${rest}`), 0, 0);
}

function renderErrorIfCollapsed(result: any, theme: any): Component {
  const text = firstText(result).trim();
  if (/^(error|access denied|failed)\b/i.test(text)) {
    return new Text(theme.fg("error", text.split("\n")[0] ?? text), 0, 0);
  }
  return EMPTY_COMPONENT;
}

function isCollapsedQuietTool(component: any): boolean {
  const isToolComponent = component instanceof ToolExecutionComponent || component?.constructor?.name === "ToolExecutionComponent";
  return isToolComponent && QUIET_TOOL_NAMES.has(component.toolName) && !component.expanded;
}

function patchToolRowSpacing(): void {
  const containerProto = Container.prototype as any;
  const globalState = globalThis as any;
  const state = globalState[PATCH_KEY] ?? {};

  if (state.containerRenderOriginal) containerProto.render = state.containerRenderOriginal;

  const containerRenderOriginal = containerProto.render;
  globalState[PATCH_KEY] = { containerRenderOriginal };

  containerProto.render = function quietToolsContainerRender(width: number): string[] {
    const children = this.children;
    if (!Array.isArray(children)) return containerRenderOriginal.call(this, width);

    const lines: string[] = [];
    let previousCollapsedQuietTool = false;

    for (const child of children) {
      let childLines = child.render(width) as string[];
      const currentCollapsedQuietTool = isCollapsedQuietTool(child);

      if (currentCollapsedQuietTool) {
        if (previousCollapsedQuietTool) {
          while (childLines[0] === "") childLines = childLines.slice(1);
        } else if (childLines[0] !== "") {
          childLines = ["", ...childLines];
        }
      }

      lines.push(...childLines);
      previousCollapsedQuietTool = currentCollapsedQuietTool;
    }

    return lines;
  };
}

export default function (pi: ExtensionAPI) {
  patchToolRowSpacing();
  pi.registerTool({
    name: "read",
    label: "read",
    description: getBuiltInTools(process.cwd()).read.description,
    parameters: getBuiltInTools(process.cwd()).read.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      const path = shortenPath(args.path, "");
      const start = typeof args.offset === "number" ? args.offset : undefined;
      const end = typeof args.limit === "number" ? (start ?? 1) + args.limit - 1 : undefined;
      const range = start || end ? `:${start ?? 1}${end ? `-${end}` : ""}` : "";
      return quiet(theme, "read", `${path}${range}`);
    },

    renderResult(result, { expanded }, theme) {
      if (!expanded) return renderErrorIfCollapsed(result, theme);
      return expandedOutput(result, theme);
    },
  });

  pi.registerTool({
    name: "grep",
    label: "grep",
    description: getBuiltInTools(process.cwd()).grep.description,
    parameters: getBuiltInTools(process.cwd()).grep.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).grep.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      const pattern = args.literal ? String(args.pattern ?? "") : `/${String(args.pattern ?? "")}/`;
      const path = shortenPath(args.path, ".");
      const bits = [pattern, `in ${path}`];
      if (args.glob) bits.push(String(args.glob));
      if (args.ignoreCase) bits.push("-i");
      return quiet(theme, "grep", bits.join(" "));
    },

    renderResult(result, { expanded }, theme) {
      if (!expanded) return renderErrorIfCollapsed(result, theme);
      return expandedOutput(result, theme);
    },
  });

  pi.registerTool({
    name: "find",
    label: "find",
    description: getBuiltInTools(process.cwd()).find.description,
    parameters: getBuiltInTools(process.cwd()).find.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      const pattern = String(args.pattern ?? "");
      const path = shortenPath(args.path, ".");
      return quiet(theme, "find", `${pattern} in ${path}`);
    },

    renderResult(result, { expanded }, theme) {
      if (!expanded) return renderErrorIfCollapsed(result, theme);
      return expandedOutput(result, theme);
    },
  });

  pi.registerTool({
    name: "ls",
    label: "ls",
    description: getBuiltInTools(process.cwd()).ls.description,
    parameters: getBuiltInTools(process.cwd()).ls.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).ls.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      return quiet(theme, "ls", shortenPath(args.path, "."));
    },

    renderResult(result, { expanded }, theme) {
      if (!expanded) return renderErrorIfCollapsed(result, theme);
      return expandedOutput(result, theme);
    },
  });
}
