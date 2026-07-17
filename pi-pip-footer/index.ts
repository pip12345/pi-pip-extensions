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
  quotaAdapters,
  quotaCacheIdentity,
  quotaProviderForModelProvider,
  installWidgetRestacker,
  settingsFor,
  truncateToWidth,
  visibleWidth,
  type QuotaCredentials,
  type QuotaProvider,
  type QuotaProviderSetting,
  type QuotaSnapshot as UsageSnapshot,
} from "../pip-common/index.ts";
import { FOOTER_KEY, FOOTER_SETTINGS_ID, USAGE_REFRESH_INTERVAL, WIDGET_KEY } from "./src/constants.ts";
import { getContextInfo, renderContextLine } from "./src/context.ts";
import { type GitState, parseGitStatus, readGitState, renderLocation } from "./src/git.ts";
import { fitSegment, joinRight, padEndVisible, renderBar, wrapSegments } from "./src/layout.ts";
import { renderExtensionStatuses, renderModelLine, renderRegisteredFooterItems, renderToolsExpandedWarning } from "./src/model.ts";
import { renderUsageLine, renderUsageWindow, quotaTestExports } from "./src/quota.ts";
import { registerFooterSettings } from "./src/settings.ts";
import { interpolateTokenBreakdown } from "./src/token/breakdown.ts";
import { createTokenController } from "./src/token/controller.ts";
import { renderTokenMetric } from "./src/token/render.ts";

type ExtensionAPI = any;

export default function (pi: ExtensionAPI) {
  registerFooterSettings(pi);
  const settings = settingsFor(pi, FOOTER_SETTINGS_ID);
  let tuiRef: { requestRender: () => void } | null = null;
  let footerInstalled = false;
  let originalSetWidget: any;
  let restoreWidgetRestacker: (() => void) | undefined;
  let gitState: GitState | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let sessionActive = false;
  let usageGeneration = 0;
  let activeUsageIdentity: string | null = null;
  let latestUsage: UsageSnapshot | null = null;
  const usageCache = new Map<string, UsageSnapshot>();

  function requestTokenRender(): void {
    tuiRef?.requestRender?.();
  }

  const tokenController = createTokenController({
    requestRender: requestTokenRender,
    setTui: (tui) => {
      tuiRef = tui;
    },
    settings,
  });

  function installFooter(ctx: any): void {
    if (!ctx.hasUI || !ctx.ui.setFooter || footerInstalled || !settings.get("enabled", true)) return;
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
          const sep = "   ";
          const modelLine = settings.get("showModel", true) ? renderModelLine(ctx, theme) : "";
          const providerLine = latestUsage?.provider ? latestUsage.provider.toLowerCase() : "";
          const labelWidth = Math.max(visibleWidth(modelLine), visibleWidth(providerLine), 1);
          const contextLine = settings.get("showContext", true) ? renderContextLine(ctx, width, theme) : "";
          const firstUsageWindow = latestUsage?.windows[0]
            ? fitSegment(width, [
                renderUsageWindow(latestUsage.windows[0], theme, 10, true),
                renderUsageWindow(latestUsage.windows[0], theme, 8, true),
                renderUsageWindow(latestUsage.windows[0], theme, 8, false),
                renderUsageWindow(latestUsage.windows[0], theme, 5, false),
              ])
            : "";
          const firstValueWidth = Math.max(visibleWidth(contextLine), visibleWidth(firstUsageWindow), 1);
          const coreLine = [
            modelLine ? padEndVisible(modelLine, labelWidth) : "",
            contextLine ? padEndVisible(contextLine, firstValueWidth) : "",
            renderLocation(ctx, theme, gitState, settings),
          ].filter(Boolean);

          const lines = wrapSegments(coreLine, width, sep);
          lines.push(...renderUsageLine(latestUsage, width, theme, labelWidth, firstValueWidth));

          if (settings.get("showPluginLines", true)) {
            const rightLines = [
              renderToolsExpandedWarning(ctx, theme),
              renderExtensionStatuses(footerData),
              ...renderRegisteredFooterItems(pi, { width, theme, ctx, region: "right" }),
            ].filter(Boolean).slice(0, 2);
            for (let i = 0; i < Math.min(2, lines.length); i++) lines[i] = joinRight(lines[i], rightLines[i], width);

            lines.push(...renderRegisteredFooterItems(pi, { width, theme, ctx, region: "below" }).flatMap((line) => wrapSegments([line], width, sep)));
          }

          return (lines.length ? lines : [theme.fg("dim", FOOTER_KEY)]).map((line) => truncateToWidth(line, width));
        },
      };
    });
  }

  async function activeModelCredentials(ctx: any): Promise<QuotaCredentials | null> {
    const provider = ctx.model?.provider;
    if (!provider || !ctx.modelRegistry?.getApiKeyForProvider) return null;
    const token = await ctx.modelRegistry.getApiKeyForProvider(provider);
    if (!token) return null;
    const stored = ctx.modelRegistry.authStorage?.get?.(provider);
    return { token, accountId: stored?.accountId ?? stored?.account_id };
  }

  async function resolveUsageTarget(ctx: any): Promise<{ provider: QuotaProvider; modelBaseUrl?: string; credentials: QuotaCredentials | null; identity: string } | null> {
    const configured = settings.get<QuotaProviderSetting>("quotaProvider", "auto");
    const model = ctx.model;
    const usingOAuth = Boolean(model && ctx.modelRegistry?.isUsingOAuth?.(model));
    const provider = detectQuotaProvider(model?.provider, configured, usingOAuth);
    if (!provider) return null;
    const matchesModelProvider = quotaProviderForModelProvider(model?.provider) === provider;
    const modelBaseUrl = matchesModelProvider && typeof model?.baseUrl === "string" ? model.baseUrl : undefined;
    const credentials = matchesModelProvider && usingOAuth
      ? await activeModelCredentials(ctx)
      : quotaAdapters[provider].getCredentials() ?? null;
    return { provider, modelBaseUrl, credentials, identity: quotaCacheIdentity(provider, modelBaseUrl, credentials) };
  }

  function cacheUsage(identity: string, snapshot: UsageSnapshot): void {
    usageCache.delete(identity);
    usageCache.set(identity, snapshot);
    while (usageCache.size > 25) usageCache.delete(usageCache.keys().next().value!);
  }

  function clearUsage(): void {
    usageGeneration++;
    activeUsageIdentity = null;
    latestUsage = null;
    requestTokenRender();
  }

  async function refreshUsageForModel(ctx: any): Promise<void> {
    if (!sessionActive) return;
    const generation = ++usageGeneration;
    let target: Awaited<ReturnType<typeof resolveUsageTarget>>;
    try {
      target = await resolveUsageTarget(ctx);
    } catch {
      if (generation === usageGeneration) clearUsage();
      return;
    }
    if (generation !== usageGeneration || !sessionActive) return;
    const identity = target?.identity ?? null;
    if (activeUsageIdentity !== identity) {
      activeUsageIdentity = identity;
      latestUsage = identity ? usageCache.get(identity) ?? null : null;
      requestTokenRender();
    }
    if (!target) return;

    const cached = usageCache.get(target.identity);
    if (cached?.windows.length) latestUsage = cached;
    let snapshot: UsageSnapshot;
    try {
      snapshot = await fetchQuotaForProvider(target.provider, {
        modelBaseUrl: target.modelBaseUrl,
        credentials: target.credentials,
      });
    } catch {
      return;
    }
    if (generation !== usageGeneration || activeUsageIdentity !== target.identity || !sessionActive) return;
    if (snapshot.windows.length) {
      cacheUsage(target.identity, snapshot);
      latestUsage = snapshot;
    } else if (!cached?.windows.length) latestUsage = snapshot;
    requestTokenRender();
  }

  function startRefreshTimer(ctx: any): void {
    if (refreshTimer) clearInterval(refreshTimer);
    const quotaEnabled = settings.get<QuotaProviderSetting>("quotaProvider", "auto") !== "off";
    refreshTimer = sessionActive && quotaEnabled ? setInterval(() => void refreshUsageForModel(ctx), USAGE_REFRESH_INTERVAL) : null;
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionActive = Boolean(ctx.hasUI && settings.get("enabled", true));
    if (!sessionActive) return;
    tokenController.resetSession(ctx);
    gitState = readGitState(ctx.cwd);
    tokenController.syncWorkingIndicator(ctx);

    if (ctx.hasUI) {
      originalSetWidget = ctx.ui.setWidget?.bind(ctx.ui);
      if (originalSetWidget) {
        restoreWidgetRestacker = installWidgetRestacker(ctx, {
          ignoredKey: WIDGET_KEY,
          watchedPlacement: "aboveEditor",
          restack: () => tokenController.installWidget(originalSetWidget, ctx),
        });
        tokenController.installWidget(originalSetWidget, ctx);
      }
    }

    installFooter(ctx);
    void refreshUsageForModel(ctx);
    startRefreshTimer(ctx);
  });

  pi.on("agent_start", async (_event: any, ctx: any) => {
    if (!sessionActive) return;
    tokenController.syncWorkingIndicator(ctx);
    if (tokenController.enabled()) tokenController.start();
  });

  pi.on("turn_start", async (_event: any, ctx: any) => {
    if (!sessionActive) return;
    tokenController.syncWorkingIndicator(ctx);
    if (tokenController.enabled()) tokenController.start();
  });

  pi.on("message_start", async (event: any) => {
    if (sessionActive && event.message?.role === "assistant" && tokenController.enabled()) tokenController.start();
  });

  pi.on("message_update", async (event: any) => {
    if (sessionActive && (event.message?.role !== "user" || event.assistantMessageEvent)) tokenController.updateBurnFromEvent(event);
  });

  pi.on("message_end", async (event: any, ctx: any) => {
    if (sessionActive) tokenController.onMessageEnd(event, ctx);
  });

  pi.on("turn_end", async (_event: any, ctx: any) => {
    if (!sessionActive) return;
    gitState = readGitState(ctx.cwd);
    requestTokenRender();
  });

  pi.on("agent_end", async (_event: any, ctx: any) => {
    if (sessionActive) tokenController.onAgentEnd(ctx);
  });

  const shutdown = async (_event: any, ctx: any) => {
    ctx?.ui?.setFooter?.(undefined);
    ctx?.ui?.setWorkingVisible?.(true);
    ctx?.ui?.setWorkingIndicator?.();
    if (originalSetWidget) originalSetWidget(WIDGET_KEY, undefined);
    restoreWidgetRestacker?.();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    tokenController.dispose();
    sessionActive = false;
    usageGeneration++;
    activeUsageIdentity = null;
    latestUsage = null;
    usageCache.clear();
    footerInstalled = false;
    tuiRef = null;
    originalSetWidget = undefined;
    restoreWidgetRestacker = undefined;
  };
  pi.on("session_shutdown", shutdown);

  pi.on("model_select", async (_event: any, ctx: any) => {
    if (!sessionActive) return;
    clearUsage();
    void refreshUsageForModel(ctx);
    startRefreshTimer(ctx);
  });
}

export const __test = {
  clampPercent,
  detectProvider: detectQuotaProvider,
  formatResetTime: quotaTestExports.formatResetTime,
  getContextInfo,
  getWindowLabel: quotaTestExports.getWindowLabel,
  joinRight,
  parseGitStatus,
  renderBar,
  renderContextLine,
  interpolateTokenBreakdown,
  renderTokenMetric,
  renderExtensionStatuses,
  renderToolsExpandedWarning,
  renderUsageLine,
  renderUsageWindow,
  WIDGET_KEY,
};
