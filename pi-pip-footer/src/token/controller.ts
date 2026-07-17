import { formatCost, formatTokenCount, normalizeUsage, truncateToWidth, type ScopedSettings } from "../../../pip-common/index.ts";
import { TOKEN_HIGHLIGHT_MS, TOKEN_RENDER_TICK_MS, TOKEN_SPINNER, TOKEN_SPINNER_FRAME_MS, WIDGET_KEY } from "../constants.ts";
import { fitSegment } from "../layout.ts";
import { addTokenBreakdown, diffTokenBreakdown, getHistoricalSessionTokens, interpolateTokenBreakdown, tokenBreakdownFromUsage, type TokenBreakdown } from "./breakdown.ts";
import { renderTokenMetric } from "./render.ts";

export interface TokenControllerDeps {
  requestRender(): void;
  setTui(tui: { requestRender: () => void } | null): void;
  settings: ScopedSettings;
}

export interface TokenController {
  syncWorkingIndicator(ctx: any): void;
  enabled(): boolean;
  resetSession(ctx: any): void;
  installWidget(originalSetWidget: any, ctx: any): void;
  start(): void;
  stop(): void;
  dispose(): void;
  updateBurnFromEvent(event: any): void;
  onMessageEnd(event: any, ctx: any): void;
  onAgentEnd(ctx: any): void;
}

export function createTokenController(deps: TokenControllerDeps): TokenController {
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

  function tokenCounterEnabled(): boolean {
    return deps.settings.get("showTokenCounter", true);
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
    return deps.settings.get<"↻" | "c" | "▣" | "◫" | "□">("cacheIcon", "↻");
  }

  function tokenValuesChanged(previous: TokenBreakdown | undefined, next: TokenBreakdown | undefined): boolean {
    if (!previous || !next) return false;
    return previous.input !== next.input || previous.output !== next.output || previous.cache !== next.cache || previous.latestCacheHitRate !== next.latestCacheHitRate || (previous.cost ?? 0) !== (next.cost ?? 0);
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
      deps.requestRender();
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
    const cacheHitRateSuffix = deps.settings.get("showCacheHitRate", true) && displayed.cache > 0 && displayed.latestCacheHitRate !== undefined ? `/${Math.round(displayed.latestCacheHitRate)}%` : "";
    const parts = [
      renderTokenMetric("↓", displayed.input, changed.input, theme),
      renderTokenMetric("↑", displayed.output, changed.output, theme),
      renderTokenMetric(cacheIcon(), displayed.cache, changed.cache, theme, cacheHitRateSuffix),
    ];
    let text = parts.join(" ");
    if (deps.settings.get("showTokenCost", true)) text += ` ${theme.fg("dim", "·")} ${theme.fg("dim", formatCost(displayed.cost ?? 0))}`;
    return text;
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
        deps.settings.get("showTokenCost", true) && (delta.cost ?? 0) > 0 ? dim(`+${formatCost(delta.cost ?? 0)}`) : "",
      ].filter(Boolean);
      return parts.length ? `${theme.fg("accent", "Δ")} ${parts.join(" ")}` : "";
    }

    return "";
  }

  function renderTokenLine(tokens: TokenBreakdown | undefined, theme: any): string[] {
    const base = renderTokenBase(tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cache: 0, total: 0, cost: 0 }, theme);
    const suffix = renderTokenSuffix(theme);
    return suffix ? [`${base}  ${suffix}`, base] : [base];
  }

  function installWidget(originalSetWidget: any, ctx: any): void {
    if (!originalSetWidget || !tokenCounterEnabled()) return;
    originalSetWidget(WIDGET_KEY, undefined);
    originalSetWidget(
      WIDGET_KEY,
      (tui: any, theme: any) => {
        deps.setTui(tui);
        return {
          dispose: () => deps.setTui(null),
          invalidate() {},
          render(width: number): string[] {
            const tokens = getHistoricalSessionTokens(ctx) ?? pendingSettledTokens ?? previousSettledTokens;
            const tokenBlock = fitSegment(width, renderTokenLine(tokens, theme));
            return [tokenBlock ? truncateToWidth(tokenBlock, width) : " "];
          },
        };
      },
      { placement: "aboveEditor" }
    );
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
      deps.requestRender();
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
    deps.requestRender();
  }

  function stopTokenAnimation(): void {
    if (!isAssistantStreaming && !tokenAnimationTimer) return;
    isAssistantStreaming = false;
    if (streamLiveOutputTokens <= 0 && streamEstimatedOutputTokens <= 0) liveOutputVisibleUntil = 0;
    deps.requestRender();
  }

  function disposeTokenAnimation(): void {
    if (tokenSettleTimer) clearTimeout(tokenSettleTimer);
    if (tokenDeltaTimer) clearTimeout(tokenDeltaTimer);
    if (tokenHighlightTimer) clearTimeout(tokenHighlightTimer);
    if (tokenAnimationTimer) clearInterval(tokenAnimationTimer);
    tokenSettleTimer = null;
    tokenDeltaTimer = null;
    tokenHighlightTimer = null;
    tokenAnimationTimer = null;
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
    deps.requestRender();
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
    deps.requestRender();
  }

  function settleTokenBreakdown(tokens: TokenBreakdown | undefined, options: { showDeltaReceipt: boolean }): void {
    displayPhase = "idle";
    if (!tokens) return deps.requestRender();

    if (!options.showDeltaReceipt) {
      latestTokenDelta = undefined;
      tokenDeltaVisibleUntil = 0;
      return deps.requestRender();
    }

    latestTokenDelta = diffTokenBreakdown(previousSettledTokens, tokens);
    previousSettledTokens = tokens;
    if (tokenDeltaTimer) clearTimeout(tokenDeltaTimer);
    tokenDeltaTimer = null;
    if (!latestTokenDelta) {
      tokenDeltaVisibleUntil = 0;
      return deps.requestRender();
    }
    tokenDeltaVisibleUntil = Date.now() + 7000;
    const runId = tokenRunId;
    tokenDeltaTimer = setTimeout(() => {
      if (runId !== tokenRunId) return;
      latestTokenDelta = undefined;
      tokenDeltaVisibleUntil = 0;
      tokenDeltaTimer = null;
      deps.requestRender();
    }, Math.max(0, tokenDeltaVisibleUntil - Date.now()));
    deps.requestRender();
  }

  function onMessageEnd(event: any, ctx: any): void {
    if (event.message?.role === "user") return;
    const messageTokens = tokenBreakdownFromUsage(event.message?.usage);
    if (messageTokens?.output && streamLiveOutputTokens <= 0 && streamEstimatedOutputTokens <= 0) {
      streamLiveOutputTokens = messageTokens.output;
      liveOutputVisibleUntil = Date.now() + 3000;
      ensureAnimationTimer();
    }
    const historicalTokens = getHistoricalSessionTokens(ctx, { fresh: true });
    pendingSettledTokens = historicalTokens ?? (messageTokens && previousSettledTokens ? { ...previousSettledTokens } : pendingSettledTokens);
    if (!historicalTokens && messageTokens && pendingSettledTokens) addTokenBreakdown(pendingSettledTokens, messageTokens);
    else if (!historicalTokens && messageTokens) pendingSettledTokens = messageTokens;
    deps.requestRender();
  }

  function onAgentEnd(ctx: any): void {
    stopTokenAnimation();
    const historicalTokens = getHistoricalSessionTokens(ctx, { fresh: true });
    const tokens = pendingSettledTokens && (!historicalTokens || pendingSettledTokens.total >= historicalTokens.total) ? pendingSettledTokens : historicalTokens;
    pendingSettledTokens = undefined;
    scheduleSettleTokenBreakdown(tokens, { showDeltaReceipt: true });
  }

  return {
    syncWorkingIndicator,
    enabled: tokenCounterEnabled,
    resetSession(ctx: any) {
      previousSettledTokens = getHistoricalSessionTokens(ctx);
    },
    installWidget,
    start: startTokenAnimation,
    stop: stopTokenAnimation,
    dispose: disposeTokenAnimation,
    updateBurnFromEvent: updateTokenBurnFromEvent,
    onMessageEnd,
    onAgentEnd,
  };
}
