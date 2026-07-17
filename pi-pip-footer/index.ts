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
  installWidgetRestacker,
  applyTemporaryLiveModelsDevCostFallback,
  settingsFor,
  truncateToWidth,
  visibleWidth,
  type QuotaProviderSetting,
  type QuotaSnapshot as UsageSnapshot,
} from "../pip-common/index.ts";
import { FOOTER_KEY, FOOTER_SETTINGS_ID, USAGE_REFRESH_INTERVAL, WIDGET_KEY } from "./src/constants.ts";
import { getContextInfo, renderContextLine } from "./src/context.ts";
import { type GitState, parseGitStatus, readGitState, renderLocation } from "./src/git.ts";
import { fitSegment, joinRight, padEndVisible, renderBar, wrapSegments } from "./src/layout.ts";
import { renderExtensionStatuses, renderModelLine, renderRegisteredFooterItems, renderToolsExpandedWarning } from "./src/model.ts";
import { renderUsageLine, renderUsageWindow, quotaTestExports, usageCache } from "./src/quota.ts";
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
  let activeProvider: "codex" | "anthropic" | "copilot" | null = null;
  let latestUsage: UsageSnapshot | null = null;

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

  function refreshUsageForModel(ctx: any): void {
    const configured = settings.get<QuotaProviderSetting>("quotaProvider", "auto");
    const provider = detectQuotaProvider(ctx.model?.provider, configured);
    activeProvider = provider;
    if (!provider) {
      latestUsage = null;
      requestTokenRender();
      return;
    }
    const cached = usageCache.get(provider);
    if (cached?.windows.length) latestUsage = cached;
    fetchQuotaForProvider(provider, { modelBaseUrl: typeof ctx.model?.baseUrl === "string" ? ctx.model.baseUrl : undefined })
      .then((snapshot) => {
        if (activeProvider !== provider) return;
        if (snapshot.error || snapshot.windows.length || !cached?.windows.length) latestUsage = snapshot;
        if (snapshot.windows.length) usageCache.set(provider, snapshot);
        requestTokenRender();
      })
      .catch(() => {});
  }

  function startRefreshTimer(ctx: any): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => refreshUsageForModel(ctx), USAGE_REFRESH_INTERVAL);
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
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
    refreshUsageForModel(ctx);
    startRefreshTimer(ctx);
  });

  pi.on("agent_start", async (_event: any, ctx: any) => {
    tokenController.syncWorkingIndicator(ctx);
    if (tokenController.enabled()) tokenController.start();
  });

  pi.on("turn_start", async (_event: any, ctx: any) => {
    tokenController.syncWorkingIndicator(ctx);
    if (tokenController.enabled()) tokenController.start();
  });

  pi.on("message_start", async (event: any) => {
    if (event.message?.role === "assistant" && tokenController.enabled()) tokenController.start();
  });

  pi.on("message_update", async (event: any) => {
    if (event.message?.role !== "user" || event.assistantMessageEvent) tokenController.updateBurnFromEvent(event);
  });

  pi.on("message_end", async (event: any, ctx: any) => {
    await applyTemporaryLiveModelsDevCostFallback(event.message);
    tokenController.onMessageEnd(event, ctx);
  });

  pi.on("turn_end", async (_event: any, ctx: any) => {
    gitState = readGitState(ctx.cwd);
    requestTokenRender();
  });

  pi.on("agent_end", async (_event: any, ctx: any) => {
    tokenController.onAgentEnd(ctx);
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
    footerInstalled = false;
    tuiRef = null;
    originalSetWidget = undefined;
    restoreWidgetRestacker = undefined;
  };
  pi.on("session_shutdown", shutdown);

  pi.on("model_select", async (_event: any, ctx: any) => {
    refreshUsageForModel(ctx);
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
