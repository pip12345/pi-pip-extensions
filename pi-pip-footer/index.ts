/**
 * Pip Footer Extension
 *
 * Successor to pi-token-counter. Keeps the live token counter / working indicator
 * above the editor, and adds a custom below-editor footer for context,
 * model/thinking, subscription quota, and future pip plugin footer lines.
 */

import {
  clampPercent,
  detectQuotaProvider,
  fetchQuotaForProvider,
  formatResetTime,
  formatTokenCount,
  getWindowLabel,
  normalizeUsage,
  pipSettings,
  registerSettingsSection,
  renderRegisteredFooterItems,
  setting,
  truncateToWidth,
  visibleWidth,
  type QuotaProviderSetting,
  type QuotaSnapshot as UsageSnapshot,
  type QuotaWindow as RateWindow,
} from "pip-common";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";

type ExtensionAPI = any;

const TOKEN_SPINNER = ["◐", "◓", "◑", "◒"];
const TOKEN_HIGHLIGHT_MS = 1600;
const TOKEN_RENDER_TICK_MS = 80;
const TOKEN_SPINNER_FRAME_MS = 140;
const WIDGET_KEY = "pi-pip-footer-token-counter";
const FOOTER_KEY = "pi-pip-footer";
const USAGE_REFRESH_INTERVAL = 5 * 60_000;
const BAR_FILLED = "━";
const BAR_EMPTY = "─";
const FOOTER_SETTINGS_ID = "pi-pip-footer";

interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cache: number;
  total: number;
}

interface GitState {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

const usageCache = new Map<string, UsageSnapshot>();

registerSettingsSection({
  id: FOOTER_SETTINGS_ID,
  title: "Pip Footer",
  description: "Pip footer with quotas, context, model, and the existing above-editor token counter.",
  order: 20,
  settings: {
    enabled: setting.boolean({ label: "Enabled", default: true, order: 1 }),
    quotaProvider: setting.enum({
      label: "Quota provider",
      default: "auto",
      choices: ["auto", "codex", "anthropic", "copilot", "off"] as const,
      order: 2,
    }),
    showContext: setting.boolean({ label: "Context bar", default: true, order: 3 }),
    showModel: setting.boolean({ label: "Model", default: true, order: 4 }),
    showTokenCounter: setting.boolean({ label: "Above-editor token counter", default: true, order: 5 }),
    cacheIcon: setting.enum({ label: "Cache icon", default: "↻", choices: ["↻", "c", "▣", "◫", "□"] as const, order: 6 }),
    showPluginLines: setting.boolean({ label: "Plugin lines", default: true, order: 7 }),
    showGit: setting.boolean({ label: "Git", default: false, order: 8 }),
    showCwd: setting.enum({ label: "CWD", default: "project", choices: ["off", "project", "path"] as const, order: 9 }),
  },
});

function buildSessionContext(entries: any[], leafId: unknown): { messages: any[]; thinkingLevel?: string } {
  const byId = new Map<unknown, any>();
  for (const entry of entries ?? []) byId.set(entry?.id, entry);

  const chain: any[] = [];
  let current = byId.get(leafId) ?? entries?.[entries.length - 1];
  const seen = new Set<unknown>();

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = byId.get(current.parentId ?? current.parent);
  }

  const ordered = chain.length ? chain.reverse() : entries ?? [];
  const messages = ordered.flatMap((entry) => entry?.messages ?? entry?.message ?? []).filter(Boolean);
  const thinkingLevel = ordered
    .map((entry) => entry?.thinkingLevel ?? entry?.model?.reasoning?.effort ?? entry?.reasoning?.effort)
    .filter(Boolean)
    .pop();

  return { messages, thinkingLevel };
}

function fitSegment(width: number, variants: string[]): string {
  const safeWidth = Math.max(1, width);
  for (const variant of variants) {
    if (visibleWidth(variant) <= safeWidth) return variant;
  }
  return truncateToWidth(variants[variants.length - 1] || "", safeWidth);
}

function wrapSegments(segments: string[], width: number, sep: string): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let current = "";

  for (const segment of segments.filter(Boolean)) {
    const fitted = truncateToWidth(segment, safeWidth);
    if (!current) {
      current = fitted;
      continue;
    }
    const candidate = `${current}${sep}${fitted}`;
    if (visibleWidth(candidate) <= safeWidth) current = candidate;
    else {
      lines.push(truncateToWidth(current, safeWidth));
      current = fitted;
    }
  }

  if (current) lines.push(truncateToWidth(current, safeWidth));
  return lines;
}

function joinRight(left: string, right: string | undefined, width: number): string {
  if (!right?.trim()) return left;
  const leftWidth = visibleWidth(left);
  if (leftWidth >= width) return left;
  const minGap = 2;
  const availableRight = width - leftWidth - minGap;
  if (availableRight <= 0) return left;
  const fittedRight = truncateToWidth(right, availableRight);
  if (!fittedRight.trim()) return left;
  const gap = Math.max(minGap, width - leftWidth - visibleWidth(fittedRight));
  return `${left}${" ".repeat(gap)}${fittedRight}`;
}

function addTokenBreakdown(total: TokenBreakdown, next: TokenBreakdown): void {
  total.input += next.input;
  total.output += next.output;
  total.cacheRead += next.cacheRead;
  total.cacheWrite += next.cacheWrite;
  total.cache += next.cache;
  total.total += next.total;
}

function getBranchTokens(ctx: any): TokenBreakdown | undefined {
  const entries = ctx.sessionManager.getEntries();
  const leafId = ctx.sessionManager.getLeafId();
  const context = buildSessionContext(entries, leafId);
  const total: TokenBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cache: 0, total: 0 };
  let found = false;

  for (const message of context.messages) {
    if (message?.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") continue;
    const usage = normalizeUsage(message.usage);
    if (!usage) continue;
    addTokenBreakdown(total, usage);
    found = true;
  }

  return found ? total : undefined;
}

function diffTokenBreakdown(previous: TokenBreakdown | undefined, next: TokenBreakdown): TokenBreakdown | undefined {
  if (!previous) return next.total > 0 ? { ...next } : undefined;

  const input = Math.max(0, next.input - previous.input);
  const output = Math.max(0, next.output - previous.output);
  const cacheRead = Math.max(0, next.cacheRead - previous.cacheRead);
  const cacheWrite = Math.max(0, next.cacheWrite - previous.cacheWrite);
  const total = Math.max(0, next.total - previous.total);
  const cache = cacheRead + cacheWrite;

  if (input + output + cache + total <= 0) return undefined;
  return { input, output, cacheRead, cacheWrite, cache, total };
}

function renderBar(usedPercent: number, width: number, theme: any, kind: "quota" | "ctx" = "quota"): string {
  const clamped = clampPercent(usedPercent);
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  const color = kind === "ctx" ? (clamped >= 90 ? "error" : clamped >= 70 ? "warning" : "accent") : clamped >= 92 ? "error" : clamped >= 85 ? "warning" : "accent";
  return theme.fg(color, BAR_FILLED.repeat(filled)) + theme.fg("dim", BAR_EMPTY.repeat(empty));
}

function renderUsageWindow(window: RateWindow, theme: any, barWidth = 10, includeReset = true): string {
  const dim = (s: string) => theme.fg("dim", s);
  const reset = includeReset && window.resetsIn ? ` ${dim(window.resetsIn)}` : "";
  return `${dim(window.label)} ${renderBar(window.usedPercent, barWidth, theme)} ${dim(`${Math.round(window.usedPercent)}%`)}${reset}`;
}

function renderUsageLine(usage: UsageSnapshot | null, width: number, theme: any): string[] {
  if (!usage?.windows.length) return [];
  const sep = ` ${theme.fg("dim", ">")} `;
  const segments = [theme.fg("accent", usage.provider)];
  for (const window of usage.windows) {
    segments.push(
      fitSegment(width, [
        renderUsageWindow(window, theme, 10, true),
        renderUsageWindow(window, theme, 8, true),
        renderUsageWindow(window, theme, 8, false),
        renderUsageWindow(window, theme, 5, false),
      ])
    );
  }
  return wrapSegments(segments, width, sep);
}

function getContextInfo(ctx: any): { percentage: number; used: number; total: number } {
  const direct = ctx.getContextUsage?.();
  const modelWindow = ctx.model?.contextWindow ?? direct?.contextWindow ?? direct?.total ?? 0;
  if (direct?.tokens && modelWindow) return { percentage: (direct.tokens / modelWindow) * 100, used: direct.tokens, total: modelWindow };
  if (!modelWindow) return { percentage: 0, used: 0, total: 0 };
  const tokens = getBranchTokens(ctx)?.total ?? 0;
  return { percentage: tokens ? (tokens / modelWindow) * 100 : 0, used: tokens, total: modelWindow };
}

function renderContextLine(ctx: any, width: number, theme: any): string {
  const info = getContextInfo(ctx);
  const label = theme.fg("dim", "ctx ");
  if (!info.total) return `${label}${theme.fg("dim", "unknown")}`;
  return fitSegment(width, [
    `${label}${renderBar(info.percentage, 12, theme, "ctx")} ${theme.fg("accent", `${formatTokenCount(info.used)}/${formatTokenCount(info.total)}`)}`,
    `${label}${renderBar(info.percentage, 10, theme, "ctx")} ${theme.fg("accent", `${Math.round(info.percentage)}%`)}`,
    `${label}${renderBar(info.percentage, 8, theme, "ctx")}`,
  ]);
}

function renderModelLine(ctx: any, theme: any): string {
  const model = ctx.model;
  const modelName = model?.id?.split("/").pop() || "no-model";
  const entries = ctx.sessionManager?.getEntries?.() ?? [];
  const thinking = buildSessionContext(entries, ctx.sessionManager?.getLeafId?.()).thinkingLevel ?? model?.reasoning?.effort;
  const base = theme.fg("muted", modelName);
  return thinking && thinking !== "off" ? `${base} ${theme.fg("dim", ">")} ${theme.fg("accent", thinking)}` : base;
}

function renderToolsExpandedWarning(ctx: any, theme: any): string {
  return ctx.ui?.getToolsExpanded?.() ? theme.fg("warning", "tools expanded") : "";
}

function parseGitStatus(output: string): GitState {
  let branch: string | null = null;
  let dirty = false;
  let ahead = 0;
  let behind = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length).trim();
    else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) {
        ahead = Number(match[1]) || 0;
        behind = Number(match[2]) || 0;
      }
    } else if (line && !line.startsWith("# ")) dirty = true;
  }
  if (branch === "(detached)") branch = null;
  return { branch, dirty, ahead, behind };
}

function readGitState(cwd: string): GitState | null {
  try {
    return parseGitStatus(execSync("git status --porcelain=v2 --branch 2>/dev/null", { cwd, encoding: "utf8", timeout: 1000 }).trimEnd());
  } catch {
    return null;
  }
}

function renderTokenMetric(label: string, value: number, changed: boolean, theme: any): string {
  const labelColor = (s: string) => theme.fg("dim", s);
  const valueColor = (s: string) => theme.fg(changed ? "success" : "accent", s);
  return `${labelColor(`${label}:`)}${valueColor(formatTokenCount(value))}`;
}

function interpolateTokenBreakdown(from: TokenBreakdown, to: TokenBreakdown, progress: number): TokenBreakdown {
  const p = Math.max(0, Math.min(1, progress));
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * p);
  const cache = lerp(from.cache, to.cache);
  return {
    input: lerp(from.input, to.input),
    output: lerp(from.output, to.output),
    cacheRead: 0,
    cacheWrite: 0,
    cache,
    total: lerp(from.total, to.total),
  };
}

function renderLocation(ctx: any, theme: any, gitState: GitState | null): string {
  const cwdSetting = pipSettings.get<"off" | "project" | "path">(`${FOOTER_SETTINGS_ID}.showCwd`);
  const parts: string[] = [];
  if (cwdSetting !== "off") {
    const home = homedir();
    const cwd = cwdSetting === "project" ? basename(ctx.cwd) : String(ctx.cwd).startsWith(home) ? `~${String(ctx.cwd).slice(home.length)}` : ctx.cwd;
    parts.push(theme.fg("accent", cwd));
  }
  if (pipSettings.get<boolean>(`${FOOTER_SETTINGS_ID}.showGit`) && gitState?.branch) {
    let branch = theme.fg(gitState.dirty ? "warning" : "success", gitState.branch);
    if (gitState.dirty) branch += theme.fg("warning", " *");
    if (gitState.ahead) branch += theme.fg("success", ` ↑${gitState.ahead}`);
    if (gitState.behind) branch += theme.fg("error", ` ↓${gitState.behind}`);
    parts.push(branch);
  }
  return parts.join(` ${theme.fg("dim", ">")} `);
}

export default function (pi: ExtensionAPI) {
  let tuiRef: { requestRender: () => void } | null = null;
  let footerInstalled = false;
  let originalSetWidget: any;
  let originalSetWidgetMethod: any;
  let gitState: GitState | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let activeProvider: "codex" | "anthropic" | "copilot" | null = null;
  let latestUsage: UsageSnapshot | null = null;

  let tokenAnimationTimer: ReturnType<typeof setInterval> | null = null;
  let tokenSettleTimer: ReturnType<typeof setTimeout> | null = null;
  let tokenDeltaTimer: ReturnType<typeof setTimeout> | null = null;
  let tokenHighlightTimer: ReturnType<typeof setTimeout> | null = null;
  let displayPhase: "idle" | "working" | "live" | "settling" = "idle";
  let isAssistantStreaming = false;
  let liveOutputVisibleUntil = 0;
  let tokenDeltaVisibleUntil = 0;
  let tokenHighlightVisibleUntil = 0;
  let tokenHighlightedFields = { input: false, output: false, cache: false };
  let tokenAnimationFrom: TokenBreakdown | undefined;
  let tokenAnimationTo: TokenBreakdown | undefined;
  let tokenAnimationStartedAt = 0;
  let tokenAnimationUntil = 0;
  let previousRenderedTokens: TokenBreakdown | undefined;
  let previousSettledTokens: TokenBreakdown | undefined;
  let pendingSettledTokens: TokenBreakdown | undefined;
  let latestTokenDelta: TokenBreakdown | undefined;
  let tokenRunId = 0;
  let spinnerStartedAt = Date.now();
  let streamLiveOutputTokens = 0;
  let streamEstimatedOutputTokens = 0;

  function requestTokenRender(): void {
    tuiRef?.requestRender?.();
  }

  function tokenCounterEnabled(): boolean {
    return pipSettings.get<boolean>(`${FOOTER_SETTINGS_ID}.showTokenCounter`);
  }

  function syncWorkingIndicator(ctx: any): void {
    if (!ctx?.hasUI) return;
    if (tokenCounterEnabled()) {
      ctx.ui.setWorkingVisible?.(false);
      ctx.ui.setWorkingIndicator?.({ frames: [] });
      return;
    }
    ctx.ui.setWorkingVisible?.(true);
    ctx.ui.setWorkingIndicator?.();
  }

  function cacheIcon(): "↻" | "c" | "▣" | "◫" | "□" {
    return pipSettings.get<"↻" | "c" | "▣" | "◫" | "□">(`${FOOTER_SETTINGS_ID}.cacheIcon`);
  }

  function tokenValuesChanged(previous: TokenBreakdown | undefined, next: TokenBreakdown | undefined): boolean {
    if (!previous || !next) return false;
    return previous.input !== next.input || previous.output !== next.output || previous.cache !== next.cache;
  }

  function getDisplayedTokens(now = Date.now()): TokenBreakdown | undefined {
    if (!tokenAnimationFrom || !tokenAnimationTo) return tokenAnimationTo ?? previousRenderedTokens;
    if (now >= tokenAnimationUntil) return tokenAnimationTo;
    const duration = Math.max(1, tokenAnimationUntil - tokenAnimationStartedAt);
    return interpolateTokenBreakdown(tokenAnimationFrom, tokenAnimationTo, (now - tokenAnimationStartedAt) / duration);
  }

  function startTokenValueAnimation(from: TokenBreakdown, to: TokenBreakdown, now = Date.now()): void {
    tokenAnimationFrom = { ...from };
    tokenAnimationTo = { ...to };
    tokenAnimationStartedAt = now;
    tokenAnimationUntil = now + TOKEN_HIGHLIGHT_MS;
    tokenHighlightVisibleUntil = tokenAnimationUntil;
    tokenHighlightedFields = {
      input: from.input !== to.input,
      output: from.output !== to.output,
      cache: from.cache !== to.cache,
    };
    if (tokenHighlightTimer) clearTimeout(tokenHighlightTimer);
    tokenHighlightTimer = setTimeout(() => {
      if (tokenAnimationTo) tokenAnimationFrom = { ...tokenAnimationTo };
      tokenHighlightedFields = { input: false, output: false, cache: false };
      tokenHighlightTimer = null;
      requestTokenRender();
    }, Math.max(0, tokenAnimationUntil - now));
    ensureAnimationTimer();
  }

  function renderTokenBase(tokens: TokenBreakdown | undefined, theme: any): string {
    if (!tokens) return "";
    const now = Date.now();
    const previousTarget = previousRenderedTokens;
    if (!previousTarget) {
      tokenAnimationFrom = { ...tokens };
      tokenAnimationTo = { ...tokens };
      previousRenderedTokens = { ...tokens };
    } else if (tokenValuesChanged(previousTarget, tokens)) {
      startTokenValueAnimation(getDisplayedTokens(now) ?? previousTarget, tokens, now);
      previousRenderedTokens = { ...tokens };
    }

    const displayed = getDisplayedTokens(now) ?? tokens;
    const highlighting = now < tokenHighlightVisibleUntil;
    const changed = {
      input: highlighting && tokenHighlightedFields.input,
      output: highlighting && tokenHighlightedFields.output,
      cache: highlighting && tokenHighlightedFields.cache,
    };
    return [
      renderTokenMetric("↓", displayed.input, changed.input, theme),
      renderTokenMetric("↑", displayed.output, changed.output, theme),
      renderTokenMetric(cacheIcon(), displayed.cache, changed.cache, theme),
    ].join(" ");
  }

  function renderTokenSuffix(theme: any): string {
    const spinner = TOKEN_SPINNER[Math.floor((Date.now() - spinnerStartedAt) / TOKEN_SPINNER_FRAME_MS) % TOKEN_SPINNER.length];
    if (displayPhase === "working") return theme.fg("accent", spinner);

    const liveDelta = streamLiveOutputTokens > 0 ? streamLiveOutputTokens : streamEstimatedOutputTokens;
    const showingLiveCounter = liveDelta > 0 && (displayPhase === "live" || displayPhase === "settling");
    if (showingLiveCounter) {
      const amount = theme.fg("success", `+${formatTokenCount(liveDelta)}`);
      return `${theme.fg("accent", spinner)} ${amount} ${theme.fg("dim", "out")}`;
    }

    const delta = Date.now() < tokenDeltaVisibleUntil ? latestTokenDelta : undefined;
    if (displayPhase === "idle" && delta) {
      const dim = (s: string) => theme.fg("dim", s);
      const parts = [
        delta.input > 0 ? `${dim("↓+")}${dim(formatTokenCount(delta.input))}` : "",
        delta.output > 0 ? `${dim("↑+")}${dim(formatTokenCount(delta.output))}` : "",
        delta.cache > 0 ? `${dim(`${cacheIcon()}+`)}${dim(formatTokenCount(delta.cache))}` : "",
      ].filter(Boolean);
      return parts.length ? `${theme.fg("accent", "Δ")} ${parts.join(" ")}` : "";
    }

    return "";
  }

  function renderTokenLine(tokens: TokenBreakdown | undefined, theme: any): string[] {
    const base = renderTokenBase(tokens, theme);
    if (!base) return [];
    const suffix = renderTokenSuffix(theme);
    return suffix ? [`${base}  ${suffix}`, base] : [base];
  }

  function installTokenWidget(ctx: any): void {
    if (!originalSetWidget || !tokenCounterEnabled()) return;
    originalSetWidget(WIDGET_KEY, undefined);
    originalSetWidget(
      WIDGET_KEY,
      (tui: any, theme: any) => {
        tuiRef = tui;
        return {
          dispose: () => {
            tuiRef = null;
          },
          invalidate() {},
          render(width: number): string[] {
            const tokens = getBranchTokens(ctx) ?? pendingSettledTokens ?? previousSettledTokens;
            const tokenBlock = fitSegment(width, renderTokenLine(tokens, theme));
            return [tokenBlock ? truncateToWidth(tokenBlock, width) : " "];
          },
        };
      },
      { placement: "aboveEditor" }
    );
  }

  function installFooter(ctx: any): void {
    if (!ctx.hasUI || !ctx.ui.setFooter || footerInstalled || !pipSettings.get<boolean>(`${FOOTER_SETTINGS_ID}.enabled`)) return;
    footerInstalled = true;
    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      tuiRef = tui;
      const unsub = footerData?.onBranchChange?.(() => {
        gitState = readGitState(ctx.cwd);
        requestTokenRender();
      });
      return {
        dispose: () => {
          unsub?.();
          tuiRef = null;
        },
        invalidate() {},
        render(width: number): string[] {
          const sep = ` ${theme.fg("dim", ">")} `;
          const coreLine = [
            renderLocation(ctx, theme, gitState),
            pipSettings.get<boolean>(`${FOOTER_SETTINGS_ID}.showModel`) ? renderModelLine(ctx, theme) : "",
            pipSettings.get<boolean>(`${FOOTER_SETTINGS_ID}.showContext`) ? renderContextLine(ctx, width, theme) : "",
          ].filter(Boolean);

          const lines = wrapSegments(coreLine, width, sep);
          lines.push(...renderUsageLine(latestUsage, width, theme));

          if (pipSettings.get<boolean>(`${FOOTER_SETTINGS_ID}.showPluginLines`)) {
            const rightLines = [
              renderToolsExpandedWarning(ctx, theme),
              ...renderRegisteredFooterItems({ width, theme, ctx, region: "right" }),
            ].filter(Boolean).slice(0, 2);
            for (let i = 0; i < Math.min(2, lines.length); i++) lines[i] = joinRight(lines[i], rightLines[i], width);

            lines.push(...renderRegisteredFooterItems({ width, theme, ctx, region: "below" }).flatMap((line) => wrapSegments([line], width, sep)));
          }

          return (lines.length ? lines : [theme.fg("dim", FOOTER_KEY)]).map((line) => truncateToWidth(line, width));
        },
      };
    });
  }

  function refreshUsageForModel(ctx: any): void {
    const configured = pipSettings.get<QuotaProviderSetting>(`${FOOTER_SETTINGS_ID}.quotaProvider`);
    const provider = detectQuotaProvider(ctx.model?.provider, configured);
    activeProvider = provider;
    if (!provider) {
      latestUsage = null;
      requestTokenRender();
      return;
    }
    const cached = usageCache.get(provider);
    if (cached?.windows.length) latestUsage = cached;
    fetchQuotaForProvider(provider)
      .then((snapshot) => {
        if (activeProvider !== provider) return;
        if (snapshot.windows.length || !cached?.windows.length) latestUsage = snapshot;
        if (snapshot.windows.length) usageCache.set(provider, snapshot);
        requestTokenRender();
      })
      .catch(() => {});
  }

  function startRefreshTimer(ctx: any): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => refreshUsageForModel(ctx), USAGE_REFRESH_INTERVAL);
  }

  function hasActiveTokenAnimation(): boolean {
    const now = Date.now();
    return displayPhase !== "idle" || now < tokenHighlightVisibleUntil || now < tokenDeltaVisibleUntil;
  }

  function ensureAnimationTimer(): void {
    if (tokenAnimationTimer) return;
    tokenAnimationTimer = setInterval(() => {
      if (!hasActiveTokenAnimation()) {
        clearInterval(tokenAnimationTimer!);
        tokenAnimationTimer = null;
        return;
      }
      requestTokenRender();
    }, TOKEN_RENDER_TICK_MS);
  }

  function startTokenAnimation(): void {
    if (tokenSettleTimer) clearTimeout(tokenSettleTimer);
    if (tokenDeltaTimer) clearTimeout(tokenDeltaTimer);
    tokenSettleTimer = null;
    tokenDeltaTimer = null;
    tokenRunId += 1;
    liveOutputVisibleUntil = 0;
    tokenDeltaVisibleUntil = 0;
    latestTokenDelta = undefined;
    displayPhase = "working";
    isAssistantStreaming = true;
    spinnerStartedAt = Date.now();
    streamLiveOutputTokens = 0;
    streamEstimatedOutputTokens = 0;
    ensureAnimationTimer();
    requestTokenRender();
  }

  function stopTokenAnimation(): void {
    if (!isAssistantStreaming && !tokenAnimationTimer) return;
    isAssistantStreaming = false;
    if (streamLiveOutputTokens <= 0 && streamEstimatedOutputTokens <= 0) liveOutputVisibleUntil = 0;
    requestTokenRender();
  }

  function disposeTokenAnimation(): void {
    if (tokenSettleTimer) clearTimeout(tokenSettleTimer);
    if (tokenDeltaTimer) clearTimeout(tokenDeltaTimer);
    if (tokenHighlightTimer) clearTimeout(tokenHighlightTimer);
    if (tokenAnimationTimer) clearInterval(tokenAnimationTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    tokenSettleTimer = null;
    tokenDeltaTimer = null;
    tokenHighlightTimer = null;
    tokenAnimationTimer = null;
    refreshTimer = null;
    displayPhase = "idle";
    isAssistantStreaming = false;
    liveOutputVisibleUntil = 0;
    tokenDeltaVisibleUntil = 0;
    tokenHighlightVisibleUntil = 0;
    tokenHighlightedFields = { input: false, output: false, cache: false };
    tokenAnimationFrom = undefined;
    tokenAnimationTo = undefined;
    tokenAnimationStartedAt = 0;
    tokenAnimationUntil = 0;
    previousRenderedTokens = undefined;
    pendingSettledTokens = undefined;
    latestTokenDelta = undefined;
    streamLiveOutputTokens = 0;
    streamEstimatedOutputTokens = 0;
  }

  function updateTokenBurnFromEvent(event: any): void {
    const assistantEvent = event?.assistantMessageEvent;
    if (!assistantEvent) return;
    let sawOutput = false;
    const live = normalizeUsage(assistantEvent.partial?.usage)?.output;
    if (typeof live === "number" && live > 0) {
      streamLiveOutputTokens = Math.max(streamLiveOutputTokens, live);
      sawOutput = true;
    }
    if (assistantEvent.type === "text_delta" && assistantEvent.delta) {
      streamEstimatedOutputTokens += Math.max(1, Math.ceil(String(assistantEvent.delta).length / 4));
      sawOutput = true;
    }
    if (sawOutput) {
      displayPhase = "live";
      liveOutputVisibleUntil = Date.now() + 3000;
      ensureAnimationTimer();
    }
    requestTokenRender();
  }

  function scheduleSettleTokenBreakdown(tokens: TokenBreakdown | undefined, options: { showDeltaReceipt: boolean }): void {
    const runId = tokenRunId;
    const revealInMs = Math.max(0, liveOutputVisibleUntil - Date.now());
    displayPhase = "settling";
    if (tokenSettleTimer) clearTimeout(tokenSettleTimer);
    tokenSettleTimer = setTimeout(() => {
      if (runId !== tokenRunId) return;
      liveOutputVisibleUntil = 0;
      tokenSettleTimer = null;
      settleTokenBreakdown(tokens, options);
    }, revealInMs);
    requestTokenRender();
  }

  function settleTokenBreakdown(tokens: TokenBreakdown | undefined, options: { showDeltaReceipt: boolean }): void {
    displayPhase = "idle";
    if (!tokens) return requestTokenRender();

    if (!options.showDeltaReceipt) {
      latestTokenDelta = undefined;
      tokenDeltaVisibleUntil = 0;
      return requestTokenRender();
    }

    latestTokenDelta = diffTokenBreakdown(previousSettledTokens, tokens);
    previousSettledTokens = tokens;
    if (tokenDeltaTimer) clearTimeout(tokenDeltaTimer);
    tokenDeltaTimer = null;
    if (!latestTokenDelta) {
      tokenDeltaVisibleUntil = 0;
      return requestTokenRender();
    }
    tokenDeltaVisibleUntil = Date.now() + 7000;
    const runId = tokenRunId;
    tokenDeltaTimer = setTimeout(() => {
      if (runId !== tokenRunId) return;
      latestTokenDelta = undefined;
      tokenDeltaVisibleUntil = 0;
      tokenDeltaTimer = null;
      requestTokenRender();
    }, Math.max(0, tokenDeltaVisibleUntil - Date.now()));
    requestTokenRender();
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    previousSettledTokens = getBranchTokens(ctx);
    gitState = readGitState(ctx.cwd);
    syncWorkingIndicator(ctx);

    if (ctx.hasUI) {
      originalSetWidgetMethod = ctx.ui.setWidget;
      originalSetWidget = ctx.ui.setWidget?.bind(ctx.ui);
      let installingTokenWidget = false;
      const installAtBottom = () => {
        installingTokenWidget = true;
        try {
          installTokenWidget(ctx);
        } finally {
          installingTokenWidget = false;
        }
      };

      if (originalSetWidget) {
        ctx.ui.setWidget = (key: string, content: any, options?: any) => {
          const result = originalSetWidget(key, content, options);
          const placement = options?.placement ?? "aboveEditor";
          if (!installingTokenWidget && key !== WIDGET_KEY && placement === "aboveEditor") installAtBottom();
          return result;
        };
        installAtBottom();
      }
    }

    installFooter(ctx);
    refreshUsageForModel(ctx);
    startRefreshTimer(ctx);
  });

  pi.on("agent_start", async (_event: any, ctx: any) => {
    syncWorkingIndicator(ctx);
    if (tokenCounterEnabled()) startTokenAnimation();
  });

  pi.on("turn_start", async (_event: any, ctx: any) => {
    syncWorkingIndicator(ctx);
    if (tokenCounterEnabled()) startTokenAnimation();
  });

  pi.on("message_start", async (event: any) => {
    if (event.message?.role === "assistant" && tokenCounterEnabled()) startTokenAnimation();
  });

  pi.on("message_update", async (event: any) => {
    if (event.message?.role !== "user" || event.assistantMessageEvent) updateTokenBurnFromEvent(event);
  });

  pi.on("message_end", async (event: any, ctx: any) => {
    if (event.message?.role === "user") return;
    const messageTokens = normalizeUsage(event.message?.usage);
    if (messageTokens?.output && streamLiveOutputTokens <= 0 && streamEstimatedOutputTokens <= 0) {
      streamLiveOutputTokens = messageTokens.output;
      liveOutputVisibleUntil = Date.now() + 3000;
      ensureAnimationTimer();
    }
    const branchTokens = getBranchTokens(ctx);
    pendingSettledTokens = branchTokens ?? (messageTokens && previousSettledTokens ? { ...previousSettledTokens } : pendingSettledTokens);
    if (!branchTokens && messageTokens && pendingSettledTokens) addTokenBreakdown(pendingSettledTokens, messageTokens);
    else if (!branchTokens && messageTokens) pendingSettledTokens = messageTokens;
    requestTokenRender();
  });

  pi.on("turn_end", async (_event: any, ctx: any) => {
    gitState = readGitState(ctx.cwd);
    requestTokenRender();
  });

  pi.on("agent_end", async (_event: any, ctx: any) => {
    stopTokenAnimation();
    const branchTokens = getBranchTokens(ctx);
    const tokens = pendingSettledTokens && (!branchTokens || pendingSettledTokens.total >= branchTokens.total) ? pendingSettledTokens : branchTokens;
    pendingSettledTokens = undefined;
    scheduleSettleTokenBreakdown(tokens, { showDeltaReceipt: true });
  });

  const shutdown = async (_event: any, ctx: any) => {
    ctx?.ui?.setFooter?.(undefined);
    ctx?.ui?.setWorkingVisible?.(true);
    ctx?.ui?.setWorkingIndicator?.();
    if (originalSetWidget) originalSetWidget(WIDGET_KEY, undefined);
    if (ctx?.ui && originalSetWidgetMethod && ctx.ui.setWidget !== originalSetWidgetMethod) ctx.ui.setWidget = originalSetWidgetMethod;
    disposeTokenAnimation();
    footerInstalled = false;
    tuiRef = null;
    originalSetWidget = undefined;
    originalSetWidgetMethod = undefined;
  };
  pi.on("session_shutdown", shutdown);
  pi.on("session_end", shutdown);

  pi.on("model_select", async (_event: any, ctx: any) => {
    refreshUsageForModel(ctx);
    startRefreshTimer(ctx);
  });
}

export const __test = {
  clampPercent,
  detectProvider: detectQuotaProvider,
  formatResetTime,
  getContextInfo,
  getWindowLabel,
  joinRight,
  parseGitStatus,
  renderBar,
  interpolateTokenBreakdown,
  renderTokenMetric,
  renderToolsExpandedWarning,
  renderUsageLine,
  renderUsageWindow,
};
