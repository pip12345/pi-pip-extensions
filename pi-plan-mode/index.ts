import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { branchEntries, registerSettingsSection, restoreLatestCustomState, setPipReadOnlyState, setting, settingsFor, themeFg, truncateToWidth } from "../pip-common/index.ts";

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

const UNSAFE_SHELL = /(;|&|\||`|\$\(|\n|<|>{1,2})/;
const READONLY_COMMANDS = new Set(["cat", "ls", "grep", "find", "rg", "fd", "head", "tail", "wc", "pwd", "echo", "printf", "file", "stat", "du", "df", "which", "type", "env", "printenv", "uname", "whoami", "date"]);
const READONLY_GIT = new Set(["status", "log", "diff", "show"]);
const READONLY_GIT_BRANCH_FLAGS = new Set(["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "--contains", "--merged", "--no-merged", "--list"]);
const READONLY_PACKAGE = new Set(["list", "ls", "view", "info", "outdated"]);

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

const scopedSettings = settingsFor(SETTINGS_ID);
const settingValue = scopedSettings.get;

function settingsEnabled(): boolean {
  return settingValue("enabled", true);
}

function indicatorEnabled(): boolean {
  return settingValue("indicator", true);
}

function packageManagerReadOnly(tokens: string[]): boolean {
  const sub = tokens[1];
  if (READONLY_PACKAGE.has(sub)) return true;
  if (sub !== "audit") return false;
  return tokens.slice(2).every((token) => token.startsWith("-") && token !== "fix");
}

function gitReadOnly(tokens: string[]): boolean {
  const sub = tokens[1];
  if (READONLY_GIT.has(sub)) return true;
  if (sub !== "branch") return false;
  const args = tokens.slice(2);
  return args.every((arg) => READONLY_GIT_BRANCH_FLAGS.has(arg));
}

export function isReadOnlyBash(command: string): boolean {
  const normalized = String(command ?? "").trim().replace(/\\\n\s*/g, " ");
  if (!normalized) return false;
  if (UNSAFE_SHELL.test(normalized)) return false;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const cmd = tokens[0];
  if (READONLY_COMMANDS.has(cmd)) return true;
  if (cmd === "git") return gitReadOnly(tokens);
  if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn") return packageManagerReadOnly(tokens);
  if ((cmd === "node" || cmd === "python" || cmd === "python3") && tokens[1] === "--version" && tokens.length === 2) return true;
  return false;
}

function emptyState(): PlanModeState {
  return { active: false, updatedAt: 0 };
}

function normalizeState(data: any): PlanModeState {
  return { active: Boolean(data?.active), updatedAt: typeof data?.updatedAt === "number" ? data.updatedAt : Date.now() };
}

export function stateFromBranch(entries: any[]): PlanModeState {
  return restoreLatestCustomState(entries, CUSTOM_TYPE, normalizeState, emptyState);
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
  const reminder = `
Plan mode is active. You are in read-only planning mode. Do not edit files, write files, run mutating shell commands, install packages, commit, or otherwise change project/system state. Use read/search tools to understand the codebase.

Before proposing non-trivial implementation work, produce a concise plan that includes:
- Evidence read: files/docs/source inspected
- Root cause / design owner: exact abstraction responsible
- Proposed change: numbered implementation plan
- Affected files/behaviors
- Regression risks
- Tests to add/run
- Simplification: what can be removed, reused, generalized, or simplified
- Questions, if any, labeled Q1, Q2, Q3...

Before finishing the plan, make sure:
1. You have read the owning implementation file(s).
2. You have checked adjacent patterns/tests.
3. You have identified the owning abstraction.
4. You have listed affected files/behaviors.
5. You have stated concrete evidence for the root cause or design claim.

If any evidence item is missing, say what is missing instead of inventing confidence. End with a clear next-step question.`;

  return `${systemPrompt}\n${reminder}`;
}

export default function planModeExtension(pi: ExtensionAPI) {
  let state: PlanModeState = { active: false, updatedAt: 0 };
  let currentCtx: any;

  const effectiveActive = () => settingsEnabled() && state.active;

  function updateIndicator(ctx = currentCtx): void {
    currentCtx = ctx;
    setPipReadOnlyState(SETTINGS_ID, effectiveActive());
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
    setPipReadOnlyState(SETTINGS_ID, false);
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
