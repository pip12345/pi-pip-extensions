import { createHash } from "node:crypto";
import {
  addUsage as addTokens,
  boxLines,
  emptyUsage as emptyTokens,
  normalizeUsage,
  applyTemporaryLiveModelsDevCostFallback,
  hasTuiCustom,
  padAnsi,
  padLeftAnsi,
  moveSelection,
  PipCustomComponent,
  printableInput,
  selectionOffset,
  textFromContent,
  truncateToWidth,
  type TokenUsage as Tokens,
} from "../pip-common/index.ts";
import { groupGlobal } from "./src/usage/rollups.ts";
import { initializeUsageStorage, readRollups, updateRollups } from "./src/usage/storage.ts";
import type { GroupBy, RangeKey } from "./src/usage/types.ts";

type ExtensionAPI = any;
type Theme = any;

type Page = "session" | "global";

interface SessionRow extends Tokens {
  index: number;
  prompt: string;
  provider: string;
  model: string;
  timestamp: number;
  contextTokens: number;
  contextPercent: number | null;
  contextWindow: number;
  assistantCount: number;
  subagentCount: number;
  parent: Tokens;
  subagents: Tokens;
  cumulative: Tokens;
}

const RANGE_LABELS: Record<RangeKey, string> = { today: "today", "7d": "last 7d", "30d": "last 30d", all: "all time" };

function fmt(n: number, compact = true): string {
  if (!compact) return Math.round(n).toLocaleString();
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${Math.round(n)}`;
}

function money(n: number): string {
  if (!n) return "-";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function hashId(parts: unknown[]): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

function bar(value: number, max: number, width: number, theme: Theme, color = "accent"): string {
  const w = Math.max(1, width);
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(pct * w);
  return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(w - filled));
}

function contextBar(percent: number | null, width: number, theme: Theme): string {
  const p = percent ?? 0;
  const color = p >= 90 ? "error" : p >= 70 ? "warning" : p >= 50 ? "accent" : "success";
  return bar(p, 100, width, theme, color);
}

function scrollIndicator(selected: number, total: number, width: number, theme: Theme): string {
  if (total <= 1) return theme.fg("dim", "scroll ") + theme.fg("success", "█".repeat(width));
  const pos = Math.round((selected / Math.max(1, total - 1)) * (width - 1));
  return theme.fg("dim", "scroll ") + Array.from({ length: width }, (_, i) => theme.fg(i === pos ? "accent" : "dim", i === pos ? "█" : "─")).join("");
}

function tokenDetailRow(label: string, tokens: Tokens, compact: boolean): string {
  const labelW = 6;
  const cell = (name: string, value: string, width: number) => padAnsi(`${name}:${value}`, width);
  return [
    padAnsi(label, labelW),
    cell("input", fmt(tokens.input, compact), 14),
    cell("output", fmt(tokens.output, compact), 14),
    cell("cache read", fmt(tokens.cacheRead, compact), 18),
    cell("cache write", fmt(tokens.cacheWrite, compact), 19),
    cell("cost", money(tokens.cost), 12),
  ].join("  ");
}

function emptySessionRow(modelWindow: number, prompt: string, timestamp: number): SessionRow {
  return {
    ...emptyTokens(),
    index: 0,
    prompt,
    provider: "unknown",
    model: "unknown",
    timestamp,
    contextTokens: 0,
    contextWindow: modelWindow,
    contextPercent: null,
    assistantCount: 0,
    subagentCount: 0,
    parent: emptyTokens(),
    subagents: emptyTokens(),
    cumulative: emptyTokens(),
  };
}

function subagentUsagesFromToolResult(msg: any): Tokens[] {
  if (msg?.role !== "toolResult" || msg?.toolName !== "subagent") return [];
  const out: Tokens[] = [];
  const add = (value: any) => {
    const usage = normalizeUsage(value);
    if (usage) out.push(usage);
  };
  add(msg.details?.run?.usage);
  for (const run of Array.isArray(msg.details?.runs) ? msg.details.runs : []) add(run?.usage);
  for (const result of Array.isArray(msg.details?.results) ? msg.details.results : []) add(result?.usage);
  return out;
}

function buildSessionRows(ctx: any): SessionRow[] {
  const modelWindow = ctx.model?.contextWindow ?? 0;
  const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
  let idx = 0;
  const rows: SessionRow[] = [];
  let current: SessionRow | null = null;

  const cumulative = emptyTokens();

  const ensureCurrent = (entry: any, prompt = "(no prompt)") => {
    current ??= emptySessionRow(modelWindow, prompt, Date.parse(entry?.timestamp) || Date.now());
    return current;
  };

  const finishCurrent = () => {
    if (current && (current.assistantCount > 0 || current.subagentCount > 0)) {
      current.index = ++idx;
      addTokens(cumulative, current);
      current.cumulative = { ...cumulative };
      rows.push(current);
    }
    current = null;
  };

  for (const entry of entries) {
    const msg = entry?.message;
    if (entry?.type === "message" && msg?.role === "user") {
      finishCurrent();
      current = emptySessionRow(modelWindow, textFromContent(msg.content).replace(/\s+/g, " ").trim() || "(empty prompt)", msg.timestamp || Date.parse(entry.timestamp) || Date.now());
      continue;
    }

    if (entry?.type === "message" && msg?.role === "assistant" && msg.stopReason !== "aborted" && msg.stopReason !== "error") {
      const t = normalizeUsage(msg.usage);
      if (!t) continue;
      const row = ensureCurrent(entry);
      if (row.assistantCount === 0) {
        const promptContext = t.input + t.cacheRead + t.cacheWrite;
        row.contextTokens = promptContext;
        row.contextWindow = modelWindow;
        row.contextPercent = modelWindow > 0 ? (promptContext / modelWindow) * 100 : null;
      }
      addTokens(row, t);
      addTokens(row.parent, t);
      row.provider = msg.provider || row.provider;
      row.model = msg.model || row.model;
      row.timestamp = msg.timestamp || Date.parse(entry.timestamp) || row.timestamp;
      row.assistantCount += 1;
    }

    if (entry?.type === "message" && msg?.role === "toolResult") {
      const usages = subagentUsagesFromToolResult(msg);
      if (!usages.length) continue;
      const row = ensureCurrent(entry);
      for (const usage of usages) {
        addTokens(row, usage);
        addTokens(row.subagents, usage);
        row.subagentCount += 1;
      }
    }
  }
  finishCurrent();
  return rows;
}

class TokenInspector extends PipCustomComponent<void> {
  private page: Page = "session";
  private range: RangeKey = "7d";
  private groupBy: GroupBy = "model";
  private selected = 0;
  private scroll = 0;
  private compact = true;
  private search = "";
  private searching = false;

  private ctx: any;

  constructor(tui: any, ctx: any, theme: Theme, done: () => void) {
    super(tui, theme, done, { closeKeys: ["escape", "ctrl+c", "ctrl+d", "q"] });
    this.ctx = ctx;
  }

  protected handleKey(key: string, raw: string): void {
    let changed = false;

    if (this.searching) {
      if (key === "escape") { this.searching = false; changed = true; }
      else if (key === "return") { this.searching = false; changed = true; }
      else if (key === "backspace" || key === "delete" || key === "ctrl+h") { this.search = this.search.slice(0, -1); changed = true; }
      else {
        const printable = printableInput(raw);
        if (printable) { this.search += printable; changed = true; }
      }
      if (changed) this.requestRender();
      return;
    }

    if (key === "tab") {
      this.page = this.page === "session" ? "global" : "session";
      this.selected = 0;
      this.scroll = 0;
      changed = true;
    } else if (key === "up" || key === "k") {
      this.move(-1);
      changed = true;
    } else if (key === "down" || key === "j") {
      this.move(1);
      changed = true;
    } else if (key === "pageup") {
      this.jump("top");
      changed = true;
    } else if (key === "pagedown") {
      this.jump("bottom");
      changed = true;
    } else if (key === "r") {
      this.compact = !this.compact;
      changed = true;
    } else if (key === "/") {
      this.page = "global";
      this.searching = true;
      changed = true;
    } else if (key === "g") {
      this.groupBy = this.groupBy === "model" ? "provider" : this.groupBy === "provider" ? "day" : "model";
      this.selected = 0;
      this.scroll = 0;
      changed = true;
    } else if (["1", "2", "3", "4"].includes(key)) {
      this.range = ({ "1": "today", "2": "7d", "3": "30d", "4": "all" } as any)[key];
      this.selected = 0;
      this.scroll = 0;
      changed = true;
    }

    if (changed) this.requestRender();
  }

  private rowCount(): number {
    return this.page === "session" ? buildSessionRows(this.ctx).length : groupGlobal(readRollups(), this.range, this.groupBy, this.search).length;
  }

  private pageSize(): number {
    return this.page === "session" ? 14 : 16;
  }

  private move(delta: number): void {
    const count = this.rowCount();
    const pageSize = this.pageSize();
    this.selected = moveSelection(this.selected, delta, count);
    this.scroll = selectionOffset(this.selected, this.scroll, count, pageSize);
  }

  private jump(target: "top" | "bottom"): void {
    const count = this.rowCount();
    const pageSize = this.pageSize();
    if (target === "top") {
      this.selected = 0;
      this.scroll = 0;
    } else {
      this.selected = Math.max(0, count - 1);
      this.scroll = Math.max(0, count - pageSize);
    }
  }

  render(width: number): string[] {
    const bodyWidth = Math.max(1, width);
    const lines = this.page === "session" ? this.renderSession(bodyWidth) : this.renderGlobal(bodyWidth);
    return boxLines(lines, bodyWidth, this.theme, { title: " Stats " });
  }

  private renderHeader(): string[] {
    const th = this.theme;
    return [
      `${this.page === "session" ? th.fg("accent", "Session") : "Session"} ${th.fg("dim", "|")} ${
        this.page === "global" ? th.fg("accent", "Global") : "Global"
      } ${th.fg("dim", "Tab switch · q close · r raw · / search · 1/2/3/4 range")}`,
    ];
  }

  private renderSession(width: number): string[] {
    const th = this.theme;
    const rows = buildSessionRows(this.ctx);
    const current = this.ctx.getContextUsage?.();
    const ctxPct = typeof current?.percent === "number" ? current.percent : null;
    const ctxTokens = typeof current?.tokens === "number" ? current.tokens : 0;
    const ctxWindow = current?.contextWindow || this.ctx.model?.contextWindow || 0;
    const maxIn = Math.max(1, ...rows.map((r) => r.input));
    const maxOut = Math.max(1, ...rows.map((r) => r.output));
    const maxCache = Math.max(1, ...rows.map((r) => r.cache));
    const lines = this.renderHeader();
    lines.push(`${th.fg("dim", "ctx")} ${fmt(ctxTokens, this.compact)}/${fmt(ctxWindow, this.compact)} ${ctxPct == null ? "?" : `${Math.round(ctxPct)}%`}  ${contextBar(ctxPct, 18, th)}`);
    lines.push("");
    const promptW = 30;
    const ctxW = 20;
    const inW = 15;
    const outW = 15;
    const cacheW = 16;
    lines.push(
      th.fg(
        "dim",
        `${padAnsi("#", 3)} ${padAnsi("User prompt", promptW)} ${padAnsi("Ctx", ctxW)} ${padLeftAnsi("ΔInput", inW)} ${padLeftAnsi("ΔOutput", outW)} ${padLeftAnsi("ΔCache", cacheW)}`
      )
    );
    const visible = rows.slice(this.scroll, this.scroll + 14);
    visible.forEach((r, i) => {
      const realIndex = this.scroll + i;
      const sel = realIndex === this.selected;
      const mark = sel ? th.fg("accent", "›") : " ";
      const idx = `${mark}${String(r.index).padStart(2)}`;
      const prompt = truncateToWidth(r.prompt, promptW);
      const ctxText = `${fmt(r.contextTokens, this.compact)} ${r.contextPercent == null ? "?" : `${Math.round(r.contextPercent)}%`}`;
      const ctxCell = `${padAnsi(ctxText, 9)} ${contextBar(r.contextPercent, 10, th)}`;
      const inCell = `${padLeftAnsi(fmt(r.input, this.compact), 8)} ${bar(r.input, maxIn, 6, th)}`;
      const outCell = `${padLeftAnsi(fmt(r.output, this.compact), 9)} ${bar(r.output, maxOut, 5, th)}`;
      const cacheCell = `${padLeftAnsi(fmt(r.cache, this.compact), 8)} ${bar(r.cache, maxCache, 7, th)}`;
      lines.push(
        `${padAnsi(idx, 3)} ${padAnsi(prompt, promptW)} ${padAnsi(ctxCell, ctxW)} ${padAnsi(inCell, inW)} ${padAnsi(outCell, outW)} ${padAnsi(cacheCell, cacheW)}`
      );
    });
    if (rows.length > 0) lines.push(scrollIndicator(this.selected, rows.length, 24, th));
    const selected = rows[this.selected];
    if (selected) {
      lines.push("");
      lines.push(th.fg("accent", `Prompt ${selected.index} details`) + th.fg("dim", `  ${selected.provider}/${selected.model} · ${selected.assistantCount} response(s) · ${selected.subagentCount} subagent(s)`));
      lines.push(tokenDetailRow("delta", selected, this.compact));
      if (selected.subagentCount > 0) {
        lines.push(tokenDetailRow("parent", selected.parent, this.compact));
        lines.push(tokenDetailRow("subagt", selected.subagents, this.compact));
      }
      lines.push(tokenDetailRow("total", selected.cumulative, this.compact));
      lines.push(`ctx at prompt ${fmt(selected.contextTokens, this.compact)} / ${fmt(selected.contextWindow, this.compact)} (${selected.contextPercent == null ? "?" : `${Math.round(selected.contextPercent)}%`})`);
      lines.push(th.fg("dim", truncateToWidth(selected.prompt, width - 4)));
    }
    return lines;
  }

  private renderGlobal(_width: number): string[] {
    const th = this.theme;
    const rows = groupGlobal(readRollups(), this.range, this.groupBy, this.search);
    const maxTotal = Math.max(1, ...rows.map((r) => r.total));
    const lines = this.renderHeader();
    lines.push(`Range: ${th.fg("accent", RANGE_LABELS[this.range])} ${th.fg("dim", "[1 today · 2 7d · 3 30d · 4 all]")}   Group: ${th.fg("accent", this.groupBy)} ${th.fg("dim", "[g]")}   Search: ${this.searching ? th.fg("accent", this.search + "_") : this.search ? th.fg("accent", this.search) : th.fg("dim", "press /")}`);
    lines.push("");
    lines.push(th.fg("dim", `${padAnsi("Model/Group", 34)} ${padLeftAnsi("Turns", 5)}   ${padAnsi("Total", 22)} ${padLeftAnsi("Input", 9)} ${padLeftAnsi("Output", 9)} ${padLeftAnsi("Cache", 9)} ${padLeftAnsi("Cost", 8)}`));
    const visible = rows.slice(this.scroll, this.scroll + 16);
    visible.forEach((r, i) => {
      const realIndex = this.scroll + i;
      const sel = realIndex === this.selected;
      const prefix = sel ? th.fg("accent", "›") : " ";
      const key = truncateToWidth(r.key, 33);
      const totalCell = `${padLeftAnsi(fmt(r.total, this.compact), 8)} ${bar(r.total, maxTotal, 12, th)}`;
      lines.push(`${prefix}${padAnsi(key, 34)} ${padLeftAnsi(String(r.turns), 5)}   ${padAnsi(totalCell, 22)} ${padLeftAnsi(
        fmt(r.input, this.compact),
        9
      )} ${padLeftAnsi(fmt(r.output, this.compact), 9)} ${padLeftAnsi(fmt(r.cache, this.compact), 9)} ${padLeftAnsi(money(r.cost), 8)}`);
    });
    if (rows.length > 0) lines.push(scrollIndicator(this.selected, rows.length, 24, th));
    const selected = rows[this.selected];
    if (selected) {
      lines.push("");
      lines.push(th.fg("accent", selected.key));
      lines.push(`turns ${selected.turns}   input ${fmt(selected.input, false)}   output ${fmt(selected.output, false)}   cache ${fmt(selected.cache, false)}   total ${fmt(selected.total, false)}   cost ${money(selected.cost)}`);
    }
    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  initializeUsageStorage();
  const seen = new Set<string>();

  pi.on("message_end", async (event: any, ctx: any) => {
    const msg = event.message;
    if (msg?.role !== "assistant" || msg.stopReason === "aborted" || msg.stopReason === "error") return;
    await applyTemporaryLiveModelsDevCostFallback(msg);
    const tokens = normalizeUsage(msg.usage);
    if (!tokens) return;
    const id = hashId([ctx.sessionManager.getSessionFile?.(), msg.timestamp, msg.provider, msg.model, tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.total]);
    if (seen.has(id)) return;
    seen.add(id);
    updateRollups({ id, ts: msg.timestamp || Date.now(), cwd: ctx.cwd, sessionFile: ctx.sessionManager.getSessionFile?.(), provider: msg.provider || "unknown", model: msg.model || "unknown", ...tokens });
  });

  pi.registerCommand("stats", {
    description: "Open token usage inspector (session and global pages)",
    handler: async (_args: string, ctx: any) => {
      if (!hasTuiCustom(ctx)) {
        ctx.ui?.notify?.("/stats requires interactive TUI", "warning");
        return;
      }
      await (ctx.ui.custom as any)((tui: any, theme: Theme, _kb: any, done: () => void) => new TokenInspector(tui, ctx, theme, done), {
        overlay: true,
        overlayOptions: { anchor: "center", width: "92%", maxHeight: "85%", minWidth: 90 },
      });
    },
  });
}

export const __test = { buildSessionRows, subagentUsagesFromToolResult };
