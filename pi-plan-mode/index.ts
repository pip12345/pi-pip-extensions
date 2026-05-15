import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pipSettings, registerSettingsSection, setting, themeFg, truncateToWidth } from "pip-common";

type BashPolicy = "readonly" | "block";
type UnknownToolsPolicy = "allow" | "block";

export interface PlanModeState {
  active: boolean;
  updatedAt: number;
}

const SETTINGS_ID = "plan-mode";
const CUSTOM_TYPE = "pip.plan-mode.state";
const WIDGET_KEY = "pi-plan-mode";

const ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls", "webfetch", "websearch", "todo_read"]);
const BLOCKED_TOOLS = new Set(["edit", "write", "todo_write", "todo_update"]);

const UNSAFE_SHELL = /(;|&&|\|\||`|\$\(|\n|>{1,2})/;
const READONLY_BASH_PATTERNS: RegExp[] = [
  /^\s*cat\b/,
  /^\s*ls\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*wc\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*which\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*date\b/,
  /^\s*git\s+(status|log|diff|show|branch)\b/,
  /^\s*npm\s+(list|ls|view|info|outdated|audit)\b/,
  /^\s*pnpm\s+(list|view|info|outdated|audit)\b/,
  /^\s*yarn\s+(list|info|why|audit)\b/,
  /^\s*node\s+--version\b/,
  /^\s*python\s+--version\b/,
  /^\s*python3\s+--version\b/,
];

registerSettingsSection({
  id: SETTINGS_ID,
  title: "Plan Mode",
  description: "Minimal read-only planning mode that blocks edits and mutating shell commands.",
  order: 45,
  settings: {
    enabled: setting.boolean({ label: "Enabled", default: true, order: 1, description: "Enable the /plan command, prompt reminder, and plan-mode tool blocking." }),
    bashPolicy: setting.enum({
      label: "Bash",
      default: "readonly",
      choices: [
        { value: "readonly", label: "readonly" },
        { value: "block", label: "block" },
      ] as const,
      order: 2,
      description: "Allow only known read-only bash commands, or block bash entirely while plan mode is active.",
    }),
    unknownTools: setting.enum({
      label: "Unknown tools",
      default: "allow",
      choices: [
        { value: "allow", label: "allow" },
        { value: "block", label: "block" },
      ] as const,
      order: 3,
      description: "Whether tools not explicitly classified by plan mode are allowed or blocked.",
    }),
    indicator: setting.boolean({ label: "Indicator", default: true, order: 4, description: "Show an above-editor plan-mode indicator while active." }),
  },
});

function settingValue<T>(key: string, fallback: T): T {
  try {
    return pipSettings.get<T>(`${SETTINGS_ID}.${key}`);
  } catch {
    return fallback;
  }
}

function settingsEnabled(): boolean {
  return settingValue("enabled", true);
}

function indicatorEnabled(): boolean {
  return settingValue("indicator", true);
}

export function isReadOnlyBash(command: string): boolean {
  const normalized = String(command ?? "").trim().replace(/\\\n\s*/g, " ");
  if (!normalized) return false;
  if (UNSAFE_SHELL.test(normalized)) return false;
  return READONLY_BASH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function stateFromBranch(entries: any[]): PlanModeState {
  let state: PlanModeState = { active: false, updatedAt: 0 };
  for (const entry of entries ?? []) {
    if ((entry?.type === "custom" && entry.customType === CUSTOM_TYPE) || entry?.customType === CUSTOM_TYPE) {
      state = { active: Boolean(entry.data?.active), updatedAt: typeof entry.data?.updatedAt === "number" ? entry.data.updatedAt : Date.now() };
    }
  }
  return state;
}

export function shouldBlockTool(toolName: string, input: any, options: { bashPolicy: BashPolicy; unknownTools: UnknownToolsPolicy }): string | undefined {
  if (BLOCKED_TOOLS.has(toolName)) return "Plan mode active. Use /plan off to enable mutating tools.";
  if (toolName === "bash") {
    if (options.bashPolicy === "block") return "Plan mode: bash is blocked. Use /plan off to exit plan mode.";
    const command = String(input?.command ?? "");
    if (!isReadOnlyBash(command)) return "Plan mode: bash command is not allowlisted as read-only. Use /plan off to exit plan mode.";
    return undefined;
  }
  if (ALLOWED_TOOLS.has(toolName)) return undefined;
  if (options.unknownTools === "block") return `Plan mode: tool ${toolName} is not explicitly allowed.`;
  return undefined;
}

function planReminder(systemPrompt: string): string {
  return `${systemPrompt}\n\nPlan mode is active. You are in read-only planning mode. Do not edit files, write files, run mutating shell commands, install packages, commit, or otherwise change project/system state. Use read/search tools to understand the codebase. Produce a concise implementation plan and ask before making changes.`;
}

function branchEntries(ctx: any): any[] {
  return ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
}

export default function planModeExtension(pi: ExtensionAPI) {
  let state: PlanModeState = { active: false, updatedAt: 0 };
  let currentCtx: any;

  const effectiveActive = () => settingsEnabled() && state.active;

  function updateIndicator(ctx = currentCtx): void {
    currentCtx = ctx;
    if (!ctx?.ui?.setWidget) return;
    if (effectiveActive() && indicatorEnabled()) {
      ctx.ui.setWidget(WIDGET_KEY, (tui: any, theme: any) => ({
        invalidate() {},
        render(width: number) {
          const text = themeFg(theme, "warning", "plan mode") + themeFg(theme, "dim", " — edits blocked");
          return [truncateToWidth(text, width)];
        },
      }), { placement: "aboveEditor" });
    } else {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  }

  function persist(active: boolean, ctx = currentCtx): void {
    state = { active, updatedAt: Date.now() };
    pi.appendEntry(CUSTOM_TYPE, { ...state });
    updateIndicator(ctx);
  }

  function setActive(active: boolean, ctx: any): void {
    persist(active, ctx);
    ctx?.ui?.notify?.(active ? "Plan mode enabled — edits blocked." : "Plan mode disabled — edits allowed.", "info");
  }

  pi.registerCommand("plan", {
    description: "Toggle minimal read-only plan mode",
    handler: async (args: string, ctx: any) => {
      currentCtx = ctx;
      const cmd = args.trim().toLowerCase();
      if (!settingsEnabled()) {
        state = { ...state, active: false };
        updateIndicator(ctx);
        ctx.ui?.notify?.("Plan mode is disabled in /pip-settings.", "warning");
        return;
      }
      if (cmd === "status") {
        ctx.ui?.notify?.(effectiveActive() ? "Plan mode is active." : "Plan mode is inactive.", "info");
        return;
      }
      if (cmd === "on") setActive(true, ctx);
      else if (cmd === "off" || cmd === "build") setActive(false, ctx);
      else if (!cmd) setActive(!state.active, ctx);
      else ctx.ui?.notify?.(`Unknown /plan command: ${cmd}`, "warning");
    },
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    currentCtx = ctx;
    state = stateFromBranch(branchEntries(ctx));
    if (!settingsEnabled()) state.active = false;
    updateIndicator(ctx);
  });

  pi.on("session_tree", async (_event: any, ctx: any) => {
    currentCtx = ctx;
    state = stateFromBranch(branchEntries(ctx));
    if (!settingsEnabled()) state.active = false;
    updateIndicator(ctx);
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    ctx?.ui?.setWidget?.(WIDGET_KEY, undefined);
  });

  pi.on("before_agent_start", async (event: any) => {
    if (!effectiveActive()) return;
    return { systemPrompt: planReminder(event.systemPrompt ?? "") };
  });

  pi.on("tool_call", async (event: any) => {
    if (!effectiveActive()) return;
    const reason = shouldBlockTool(event.toolName, event.input, {
      bashPolicy: settingValue<BashPolicy>("bashPolicy", "readonly"),
      unknownTools: settingValue<UnknownToolsPolicy>("unknownTools", "allow"),
    });
    if (reason) return { block: true, reason };
  });
}

export const __test = { SETTINGS_ID, CUSTOM_TYPE, WIDGET_KEY, ALLOWED_TOOLS, BLOCKED_TOOLS, planReminder };
