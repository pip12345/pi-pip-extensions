/**
 * Token Counter Extension
 *
 * Extracted from pi-minimal-footer-pip into a standalone above-editor widget.
 */

type ExtensionAPI = any;

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const TOKEN_SPINNER = ["◐", "◓", "◑", "◒"];
const WIDGET_KEY = "pi-token-counter";

interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cache: number;
  total: number;
}

function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6))
  ) {
    return 2;
  }
  return 1;
}

function visibleWidth(value: string): number {
  return Array.from(value.replace(ANSI_RE, "")).reduce((width, char) => width + charWidth(char), 0);
}

function truncateToWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";

  let width = 0;
  let result = "";
  let index = 0;
  const ansiAtIndex = new RegExp(ANSI_RE.source, "y");

  while (index < value.length) {
    ansiAtIndex.lastIndex = index;
    const ansi = ansiAtIndex.exec(value);
    if (ansi) {
      result += ansi[0];
      index = ansiAtIndex.lastIndex;
      continue;
    }

    const char = Array.from(value.slice(index))[0];
    const nextWidth = width + charWidth(char);
    if (nextWidth > maxWidth) break;
    result += char;
    width = nextWidth;
    index += char.length;
  }

  return result;
}

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

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${tokens}`;
}

function fitSegment(width: number, variants: string[]): string {
  const safeWidth = Math.max(1, width);
  for (const variant of variants) {
    if (visibleWidth(variant) <= safeWidth) return variant;
  }
  return truncateToWidth(variants[variants.length - 1] || "", safeWidth);
}

function usageNumber(usage: any, keys: string[]): number {
  for (const key of keys) {
    const value = key.includes(".")
      ? key.split(".").reduce((obj: any, part: string) => obj?.[part], usage)
      : usage?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  }
  return 0;
}

function normalizeUsage(usage: any): TokenBreakdown | undefined {
  if (!usage) return undefined;

  const input = usageNumber(usage, ["input", "inputTokens", "promptTokens", "prompt_tokens"]);
  const output = usageNumber(usage, ["output", "outputTokens", "completionTokens", "completion_tokens"]);
  const cacheRead = usageNumber(usage, [
    "cacheRead",
    "cache_read",
    "cachedTokens",
    "cached_tokens",
    "cacheReadInputTokens",
    "cache_read_input_tokens",
    "prompt_tokens_details.cached_tokens",
  ]);
  const cacheWrite = usageNumber(usage, [
    "cacheWrite",
    "cache_write",
    "cacheCreationInputTokens",
    "cache_creation_input_tokens",
    "cacheWriteInputTokens",
    "cache_write_input_tokens",
  ]);
  const componentTotal = input + output + cacheRead + cacheWrite;
  const nativeTotal = usageNumber(usage, ["totalTokens", "total", "total_tokens"]);
  const total = nativeTotal || componentTotal;

  if (total <= 0 && componentTotal <= 0) return undefined;
  return { input, output, cacheRead, cacheWrite, cache: cacheRead + cacheWrite, total };
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

export default function (pi: ExtensionAPI) {
  let tuiRef: { requestRender: () => void } | null = null;
  let originalSetWidget: any;
  let originalSetWidgetMethod: any;

  let tokenAnimationTimer: ReturnType<typeof setInterval> | null = null;
  let tokenSettleTimer: ReturnType<typeof setTimeout> | null = null;
  let tokenDeltaTimer: ReturnType<typeof setTimeout> | null = null;
  let displayPhase: "idle" | "working" | "live" | "settling" = "idle";
  let isAssistantStreaming = false;
  let liveOutputVisibleUntil = 0;
  let tokenDeltaVisibleUntil = 0;
  let previousSettledTokens: TokenBreakdown | undefined;
  let pendingSettledTokens: TokenBreakdown | undefined;
  let latestTokenDelta: TokenBreakdown | undefined;
  let tokenRunId = 0;
  let streamFrame = 0;
  let streamLiveOutputTokens = 0;
  let streamEstimatedOutputTokens = 0;

  function requestTokenRender(): void {
    tuiRef?.requestRender?.();
  }

  function hideWorking(ctx: any): void {
    if (!ctx?.hasUI) return;
    ctx.ui.setWorkingVisible?.(false);
    ctx.ui.setWorkingIndicator?.({ frames: [] });
  }

  function renderTokenBreakdown(tokens: TokenBreakdown | undefined, theme: any): string[] {
    if (!tokens || displayPhase !== "idle") return [];

    const dim = (s: string) => theme.fg("dim", s);
    const accent = (s: string) => theme.fg("accent", s);
    const deltaColor = (s: string) => theme.fg("success", s);
    const cache = tokens.cache;
    const delta = Date.now() < tokenDeltaVisibleUntil ? latestTokenDelta : undefined;
    const deltaPart = (value: number | undefined) => (value && value > 0 ? deltaColor(`+${formatTokenCount(value)}`) : "");

    return [
      `${dim("tok")} ${dim("i:")}${accent(formatTokenCount(tokens.input))}${deltaPart(delta?.input)} ${dim(
        "o:"
      )}${accent(formatTokenCount(tokens.output))}${deltaPart(delta?.output)} ${dim("c:")}${accent(
        formatTokenCount(cache)
      )}${deltaPart(delta?.cache)}`,
      `${dim("tok")} ${dim("i:")}${accent(formatTokenCount(tokens.input))}${deltaPart(delta?.input)} ${dim(
        "o:"
      )}${accent(formatTokenCount(tokens.output))}${deltaPart(delta?.output)}`,
      `${dim("tok")} ${dim("o:")}${accent(formatTokenCount(tokens.output))}${deltaPart(delta?.output)}`,
      `${dim("tok")} ${accent(formatTokenCount(tokens.total))}${deltaPart(delta?.total)}`,
    ];
  }

  function renderTokenBurn(theme: any): string[] {
    if (displayPhase === "idle") return [];

    const liveDelta = streamLiveOutputTokens > 0 ? streamLiveOutputTokens : streamEstimatedOutputTokens;
    const showingLiveCounter = liveDelta > 0 && (displayPhase === "live" || displayPhase === "settling");
    const spinner = TOKEN_SPINNER[streamFrame % TOKEN_SPINNER.length];
    const label = theme.fg("dim", "tok");
    const icon = theme.fg("accent", spinner);

    if (!showingLiveCounter) return [`${label} ${icon}`];

    const amount = theme.fg(streamLiveOutputTokens > 0 ? "accent" : "dim", `+${formatTokenCount(liveDelta)}`);
    return [`${label} ${icon} ${amount} ${theme.fg("dim", "out")}`, `${label} ${icon} ${amount}`, `${label} ${amount}`, amount];
  }

  function installTokenWidget(ctx: any): void {
    if (!originalSetWidget) return;
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
            const tokenBlock = fitSegment(width, [...renderTokenBurn(theme), ...renderTokenBreakdown(tokens, theme)]);
            return [tokenBlock ? truncateToWidth(tokenBlock, width) : " "];
          },
        };
      },
      { placement: "aboveEditor" }
    );
  }

  function ensureAnimationTimer(): void {
    if (tokenAnimationTimer) return;
    tokenAnimationTimer = setInterval(() => {
      streamFrame += 1;
      if (displayPhase === "idle") {
        clearInterval(tokenAnimationTimer!);
        tokenAnimationTimer = null;
      }
      requestTokenRender();
    }, 140);
  }

  function startTokenAnimation(): void {
    if (tokenSettleTimer) {
      clearTimeout(tokenSettleTimer);
      tokenSettleTimer = null;
    }
    if (tokenDeltaTimer) {
      clearTimeout(tokenDeltaTimer);
      tokenDeltaTimer = null;
    }
    tokenRunId += 1;
    liveOutputVisibleUntil = 0;
    tokenDeltaVisibleUntil = 0;
    latestTokenDelta = undefined;
    displayPhase = "working";
    isAssistantStreaming = true;
    streamFrame = 0;
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
    if (tokenAnimationTimer) clearInterval(tokenAnimationTimer);
    tokenSettleTimer = null;
    tokenDeltaTimer = null;
    tokenAnimationTimer = null;
    displayPhase = "idle";
    isAssistantStreaming = false;
    liveOutputVisibleUntil = 0;
    tokenDeltaVisibleUntil = 0;
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
      liveOutputVisibleUntil = Date.now() + 2000;
      ensureAnimationTimer();
    }
    requestTokenRender();
  }

  function scheduleSettleTokenBreakdown(tokens: TokenBreakdown | undefined): void {
    const runId = tokenRunId;
    const revealInMs = Math.max(0, liveOutputVisibleUntil - Date.now());
    displayPhase = "settling";
    if (tokenSettleTimer) clearTimeout(tokenSettleTimer);
    tokenSettleTimer = setTimeout(() => {
      if (runId !== tokenRunId) return;
      liveOutputVisibleUntil = 0;
      tokenSettleTimer = null;
      settleTokenBreakdown(tokens);
    }, revealInMs);
    requestTokenRender();
  }

  function settleTokenBreakdown(tokens: TokenBreakdown | undefined): void {
    displayPhase = "idle";
    if (!tokens) {
      requestTokenRender();
      return;
    }

    latestTokenDelta = diffTokenBreakdown(previousSettledTokens, tokens);
    previousSettledTokens = tokens;

    if (tokenDeltaTimer) {
      clearTimeout(tokenDeltaTimer);
      tokenDeltaTimer = null;
    }

    if (!latestTokenDelta) {
      tokenDeltaVisibleUntil = 0;
      requestTokenRender();
      return;
    }

    tokenDeltaVisibleUntil = Date.now() + 5000;
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
    hideWorking(ctx);

    if (!ctx.hasUI) return;
    originalSetWidgetMethod = ctx.ui.setWidget;
    originalSetWidget = ctx.ui.setWidget?.bind(ctx.ui);
    if (!originalSetWidget) return;

    let installingTokenWidget = false;
    const installAtBottom = () => {
      installingTokenWidget = true;
      try {
        installTokenWidget(ctx);
      } finally {
        installingTokenWidget = false;
      }
    };

    ctx.ui.setWidget = (key: string, content: any, options?: any) => {
      const result = originalSetWidget(key, content, options);
      const placement = options?.placement ?? "aboveEditor";
      if (!installingTokenWidget && key !== WIDGET_KEY && placement === "aboveEditor") {
        // Reinsert after the widget that was just added so token counter stays
        // closest to the editor/bottom of the above-editor widget stack.
        installAtBottom();
      }
      return result;
    };

    installAtBottom();
  });

  pi.on("agent_start", async (_event: any, ctx: any) => {
    hideWorking(ctx);
    startTokenAnimation();
  });

  pi.on("turn_start", async (_event: any, ctx: any) => {
    hideWorking(ctx);
    startTokenAnimation();
  });

  pi.on("message_start", async (event: any) => {
    if (event.message?.role === "assistant") startTokenAnimation();
  });

  pi.on("message_update", async (event: any) => {
    if (event.message?.role !== "user" || event.assistantMessageEvent) updateTokenBurnFromEvent(event);
  });

  pi.on("message_end", async (event: any, ctx: any) => {
    if (event.message?.role === "user") return;

    const messageTokens = normalizeUsage(event.message?.usage);
    if (messageTokens?.output && streamLiveOutputTokens <= 0 && streamEstimatedOutputTokens <= 0) {
      streamLiveOutputTokens = messageTokens.output;
      liveOutputVisibleUntil = Date.now() + 2000;
      ensureAnimationTimer();
    }

    stopTokenAnimation();
    const branchTokens = getBranchTokens(ctx);
    pendingSettledTokens = branchTokens ?? (messageTokens && previousSettledTokens ? { ...previousSettledTokens } : pendingSettledTokens);
    if (!branchTokens && messageTokens && pendingSettledTokens) addTokenBreakdown(pendingSettledTokens, messageTokens);
    else if (!branchTokens && messageTokens) pendingSettledTokens = messageTokens;
    scheduleSettleTokenBreakdown(branchTokens ?? pendingSettledTokens);
  });

  pi.on("turn_end", async () => {
    stopTokenAnimation();
  });

  pi.on("agent_end", async (_event: any, ctx: any) => {
    stopTokenAnimation();
    const branchTokens = getBranchTokens(ctx);
    const tokens = pendingSettledTokens && (!branchTokens || pendingSettledTokens.total >= branchTokens.total) ? pendingSettledTokens : branchTokens;
    pendingSettledTokens = undefined;
    scheduleSettleTokenBreakdown(tokens);
  });

  pi.on("session_end", async (_event: any, ctx: any) => {
    if (originalSetWidget) {
      originalSetWidget(WIDGET_KEY, undefined);
    }
    if (ctx?.ui && originalSetWidgetMethod && ctx.ui.setWidget !== originalSetWidgetMethod) {
      ctx.ui.setWidget = originalSetWidgetMethod;
    }
    disposeTokenAnimation();
    tuiRef = null;
    originalSetWidget = undefined;
    originalSetWidgetMethod = undefined;
  });
}
