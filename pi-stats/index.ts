import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { decodeKittyPrintable, matchesKey, parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { addUsage as addTokens, emptyUsage as emptyTokens, normalizeUsage, textFromContent, type TokenUsage as Tokens } from "pip-common";

type ExtensionAPI = any;
type Theme = any;

type RangeKey = "today" | "7d" | "30d" | "all";
type Page = "session" | "global";
type GroupBy = "model" | "provider" | "day";

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
  cumulative: Tokens;
}

interface GlobalUsageEvent extends Tokens {
  id: string;
  ts: number;
  cwd: string;
  sessionFile?: string;
  provider: string;
  model: string;
}

interface GlobalRow extends Tokens {
  key: string;
  turns: number;
  lastTs: number;
}

const GLOBAL_USAGE_PATH = join(homedir(), ".pi", "agent", "token-usage.jsonl");
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

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function rangeStart(range: RangeKey): number {
  const now = new Date();
  if (range === "all") return 0;
  if (range === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = range === "7d" ? 7 : 30;
  return Date.now() - days * 24 * 60 * 60 * 1000;
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

function padAnsi(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}

function padLeftAnsi(s: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(s))) + s;
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

function normalizeInputKey(data: string): string {
  if (matchesKey(data, "escape") || data === "\u001b") return "escape";
  if (matchesKey(data, "ctrl+c") || data === "\u0003") return "ctrl+c";
  if (matchesKey(data, "tab") || data === "\t") return "tab";
  if (matchesKey(data, "up") || data === "\u001b[A") return "up";
  if (matchesKey(data, "down") || data === "\u001b[B") return "down";
  if (matchesKey(data, "pageUp") || data === "\u001b[5~") return "pageup";
  if (matchesKey(data, "pageDown") || data === "\u001b[6~") return "pagedown";

  const parsed = parseKey(data);
  if (parsed) {
    if (parsed.startsWith("shift+") && parsed.length === "shift+q".length) {
      return parsed.slice("shift+".length).toLowerCase();
    }
    return parsed.toLowerCase();
  }

  const printable = decodeKittyPrintable(data);
  if (printable?.length === 1) return printable.toLowerCase();
  if (data.length === 1) return data.toLowerCase();
  return data;
}

function printableInput(data: string): string | undefined {
  const parsed = parseKey(data);
  if (parsed?.length === 1) return parsed;
  if (parsed?.startsWith("shift+") && parsed.length === "shift+q".length) return parsed.slice("shift+".length).toUpperCase();
  const printable = decodeKittyPrintable(data);
  if (printable?.length === 1) return printable;
  if (data >= " " && data.length === 1) return data;
  return undefined;
}

function box(lines: string[], width: number, title: string, theme: Theme): string[] {
  const inner = Math.max(10, width - 2);
  const t = truncateToWidth(` ${title} `, inner);
  const left = "─".repeat(Math.floor(Math.max(0, inner - visibleWidth(t)) / 2));
  const right = "─".repeat(Math.max(0, inner - visibleWidth(t) - left.length));
  const out = [theme.fg("border", `╭${left}`) + theme.fg("accent", t) + theme.fg("border", `${right}╮`)];
  for (const line of lines) out.push(theme.fg("border", "│") + padAnsi(truncateToWidth(line, inner, "…", true), inner) + theme.fg("border", "│"));
  out.push(theme.fg("border", `╰${"─".repeat(inner)}╯`));
  return out;
}

function buildSessionRows(ctx: any): SessionRow[] {
  const modelWindow = ctx.model?.contextWindow ?? 0;
  const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
  let idx = 0;
  const rows: SessionRow[] = [];
  let current: SessionRow | null = null;

  const cumulative = emptyTokens();

  const finishCurrent = () => {
    if (current && current.assistantCount > 0) {
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
      current = {
        ...emptyTokens(),
        index: 0,
        prompt: textFromContent(msg.content).replace(/\s+/g, " ").trim() || "(empty prompt)",
        provider: "unknown",
        model: "unknown",
        timestamp: msg.timestamp || Date.parse(entry.timestamp) || Date.now(),
        contextTokens: 0,
        contextWindow: modelWindow,
        contextPercent: null,
        assistantCount: 0,
        cumulative: emptyTokens(),
      };
      continue;
    }

    if (entry?.type === "message" && msg?.role === "assistant" && msg.stopReason !== "aborted" && msg.stopReason !== "error") {
      const t = normalizeUsage(msg.usage);
      if (!t) continue;
      if (!current) {
        current = {
          ...emptyTokens(),
          index: 0,
          prompt: "(no prompt)",
          provider: "unknown",
          model: "unknown",
          timestamp: msg.timestamp || Date.parse(entry.timestamp) || Date.now(),
          contextTokens: 0,
          contextWindow: modelWindow,
          contextPercent: null,
          assistantCount: 0,
          cumulative: emptyTokens(),
        };
      }
      if (current.assistantCount === 0) {
        const promptContext = t.input + t.cacheRead + t.cacheWrite;
        current.contextTokens = promptContext;
        current.contextWindow = modelWindow;
        current.contextPercent = modelWindow > 0 ? (promptContext / modelWindow) * 100 : null;
      }
      addTokens(current, t);
      current.provider = msg.provider || current.provider;
      current.model = msg.model || current.model;
      current.timestamp = msg.timestamp || Date.parse(entry.timestamp) || current.timestamp;
      current.assistantCount += 1;
    }
  }
  finishCurrent();
  return rows;
}

function readGlobalEvents(): GlobalUsageEvent[] {
  if (!existsSync(GLOBAL_USAGE_PATH)) return [];
  const lines = readFileSync(GLOBAL_USAGE_PATH, "utf8").split("\n").filter(Boolean);
  const events: GlobalUsageEvent[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event?.id && event?.model) events.push(event);
    } catch {}
  }
  return events;
}

function appendGlobalEvent(event: GlobalUsageEvent): void {
  mkdirSync(dirname(GLOBAL_USAGE_PATH), { recursive: true });
  appendFileSync(GLOBAL_USAGE_PATH, JSON.stringify(event) + "\n", "utf8");
}

function groupGlobal(events: GlobalUsageEvent[], range: RangeKey, groupBy: GroupBy, search: string): GlobalRow[] {
  const start = rangeStart(range);
  const q = search.trim().toLowerCase();
  const map = new Map<string, GlobalRow>();
  for (const e of events) {
    if (e.ts < start) continue;
    const hay = `${e.provider}/${e.model}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const key = groupBy === "provider" ? e.provider : groupBy === "day" ? dayKey(e.ts) : `${e.provider}/${e.model}`;
    const row = map.get(key) ?? { key, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cache: 0, total: 0, cost: 0, lastTs: 0 };
    row.turns += 1;
    row.input += e.input;
    row.output += e.output;
    row.cacheRead += e.cacheRead;
    row.cacheWrite += e.cacheWrite;
    row.cache += e.cache;
    row.total += e.total;
    row.cost += e.cost;
    row.lastTs = Math.max(row.lastTs, e.ts);
    map.set(key, row);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

class TokenInspector {
  private page: Page = "session";
  private range: RangeKey = "7d";
  private groupBy: GroupBy = "model";
  private selected = 0;
  private scroll = 0;
  private compact = true;
  private search = "";
  private searching = false;

  private tui: any;
  private ctx: any;
  private theme: Theme;
  private done: () => void;

  constructor(tui: any, ctx: any, theme: Theme, done: () => void) {
    this.tui = tui;
    this.ctx = ctx;
    this.theme = theme;
    this.done = done;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    let changed = false;

    if (this.searching) {
      if (matchesKey(data, "escape")) { this.searching = false; changed = true; }
      else if (matchesKey(data, "return")) { this.searching = false; changed = true; }
      else if (matchesKey(data, "backspace")) { this.search = this.search.slice(0, -1); changed = true; }
      else {
        const printable = printableInput(data);
        if (printable) { this.search += printable; changed = true; }
      }
      if (changed) this.tui?.requestRender?.();
      return;
    }

    const key = normalizeInputKey(data);

    if (key === "escape" || key === "ctrl+c" || key === "q") {
      this.done();
      return;
    } else if (key === "tab") {
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

    if (changed) this.tui?.requestRender?.();
  }

  private rowCount(): number {
    return this.page === "session" ? buildSessionRows(this.ctx).length : groupGlobal(readGlobalEvents(), this.range, this.groupBy, this.search).length;
  }

  private pageSize(): number {
    return this.page === "session" ? 14 : 16;
  }

  private move(delta: number): void {
    const count = this.rowCount();
    this.selected = Math.max(0, Math.min(Math.max(0, count - 1), this.selected + delta));
    const pageSize = this.pageSize();
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + pageSize) this.scroll = this.selected - pageSize + 1;
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
    const bodyWidth = Math.max(80, Math.min(width - 4, 120));
    const lines = this.page === "session" ? this.renderSession(bodyWidth) : this.renderGlobal(bodyWidth);
    return box(lines, bodyWidth, " Stats ", this.theme);
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
      lines.push(th.fg("accent", `Prompt ${selected.index} details`) + th.fg("dim", `  ${selected.provider}/${selected.model} · ${selected.assistantCount} response(s)`));
      lines.push(tokenDetailRow("delta", selected, this.compact));
      lines.push(tokenDetailRow("total", selected.cumulative, this.compact));
      lines.push(`ctx at prompt ${fmt(selected.contextTokens, this.compact)} / ${fmt(selected.contextWindow, this.compact)} (${selected.contextPercent == null ? "?" : `${Math.round(selected.contextPercent)}%`})`);
      lines.push(th.fg("dim", truncateToWidth(selected.prompt, width - 4)));
    }
    return lines;
  }

  private renderGlobal(_width: number): string[] {
    const th = this.theme;
    const rows = groupGlobal(readGlobalEvents(), this.range, this.groupBy, this.search);
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
  const seen = new Set<string>();
  for (const e of readGlobalEvents()) seen.add(e.id);

  pi.on("message_end", async (event: any, ctx: any) => {
    const msg = event.message;
    if (msg?.role !== "assistant" || msg.stopReason === "aborted" || msg.stopReason === "error") return;
    const tokens = normalizeUsage(msg.usage);
    if (!tokens) return;
    const id = hashId([ctx.sessionManager.getSessionFile?.(), msg.timestamp, msg.provider, msg.model, tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.total]);
    if (seen.has(id)) return;
    seen.add(id);
    appendGlobalEvent({ id, ts: msg.timestamp || Date.now(), cwd: ctx.cwd, sessionFile: ctx.sessionManager.getSessionFile?.(), provider: msg.provider || "unknown", model: msg.model || "unknown", ...tokens });
  });

  pi.registerCommand("stats", {
    description: "Open token usage inspector (session and global pages)",
    handler: async (_args: string, ctx: any) => {
      await (ctx.ui.custom as any)((tui: any, theme: Theme, _kb: any, done: () => void) => new TokenInspector(tui, ctx, theme, done), {
        overlay: true,
        overlayOptions: { anchor: "center", width: "92%", maxHeight: "85%", minWidth: 90 },
      });
    },
  });
}
