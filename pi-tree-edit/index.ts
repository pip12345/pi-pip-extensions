import { basename } from "node:path";
import { backupSessionFile, boxLines, clampSelectedIndex, cleanupBackups, ensurePipSubdir, hasTuiCustom, makeEffectiveLeafLast, PipCustomComponent, selectionOffset, setSessionHeaderLeaf, stripAnsi, truncateToWidth, visibleWidth, writeSessionRecordsAtomic } from "../pip-common/index.ts";
import { HELP_ITEMS, type Ctx, type Entry, type ExitResult, type ExtensionAPI, type FilterMode, type Theme, type TreeRow } from "./types.ts";
import { DraftSession } from "./draft.ts";
import { parseSessionFile, validateDraft } from "./session.ts";
import { buildLabels, childrenMap, clone, compactLine, contextPercentByEntry, entryKind, entryMap, entryText, expandSummaryRows, isNormalMessageEntry, isSummaryEntry, rowKey, summarySourceIds, textFromContent, visibleRows } from "./tree.ts";

function wrapHelp(items: string[], width: number, theme: Theme): string[] {
  const sep = theme.fg("dim", " · ");
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    const token = theme.fg("dim", item);
    const candidate = line ? line + sep + token : token;
    if (line && visibleWidth(candidate) > width) {
      lines.push(line);
      line = token;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const TREE_EDIT_MAX_ROWS = 40;
const TREE_EDIT_MIN_ROWS = 8;
const TREE_EDIT_RESERVED_ROWS = 12;
const TREE_EDIT_OVERLAY_MAX_HEIGHT_RATIO = 0.9;

class TreeEditComponent extends PipCustomComponent<ExitResult> {
  private draft: DraftSession;
  private ctx: Ctx;
  private selected = 0;
  private scroll = 0;
  private filterMode: FilterMode = "default";
  private searchQuery = "";
  private searchMode = false;
  private includeSubbranches = false;
  private foldedIds = new Set<string>();
  private expandedSummaryIds = new Set<string>();
  private flashSeenNonce = 0;
  private flashOn = false;
  private flashTimer: ReturnType<typeof setInterval> | null = null;
  // The overlay owns all draft mutations while open. External edit/compaction
  // dialogs create a fresh component, so these caches never outlive its draft view.
  private rowsCache?: TreeRow[];
  private allRowsCache?: TreeRow[];
  private dataCache?: { byId: Map<string, Entry>; children: Map<string | null, Entry[]>; labels: Map<string, string> };
  private contextCache?: { window: number; percentages: Map<string, number> };
  private renderedPageSize?: number;
  private centerOnFirstRender = true;

  constructor(draft: DraftSession, ctx: Ctx, tui: any, theme: Theme, done: (result?: ExitResult) => void) {
    super(tui, theme, done, { closeKeys: [] });
    this.draft = draft;
    this.ctx = ctx;
    this.selectId(this.draft.viewSelectedId ?? this.draft.targetLeafId);
  }

  private ensureFlashAnimation(): void {
    if (this.flashSeenNonce === this.draft.flashNonce || !this.draft.flashEntryIds.length) return;
    this.flashSeenNonce = this.draft.flashNonce;
    if (this.flashTimer) clearInterval(this.flashTimer);
    let ticks = 0;
    this.flashOn = true;
    this.flashTimer = setInterval(() => {
      ticks += 1;
      this.flashOn = !this.flashOn;
      this.requestRender();
      if (ticks >= 6) {
        if (this.flashTimer) clearInterval(this.flashTimer);
        this.flashTimer = null;
        this.flashOn = false;
        this.requestRender();
      }
    }, 120);
  }

  dispose(): void {
    if (this.flashTimer) {
      clearInterval(this.flashTimer);
      this.flashTimer = null;
    }
  }

  protected handleKey(key: string): void {
    const rows = this.visibleRows();
    const selectedRow = rows[this.selected];
    const selectedEntry = selectedRow?.entry;
    const selectedId = selectedEntry?.id;
    const selectedRowKey = selectedRow ? rowKey(selectedRow) : undefined;
    const isVirtual = Boolean(selectedRow?.virtual);
    let changed = false;

    const virtualReadOnly = () => {
      this.draft.message = "Virtual summary rows are read-only; use y to copy originals";
      return true;
    };

    if (this.searchMode) {
      if (key === "escape" || key === "return") this.searchMode = false;
      else if (key === "backspace" || key === "delete" || key === "ctrl+h") { this.searchQuery = this.searchQuery.slice(0, -1); this.invalidateRows(); this.selectId(selectedRowKey ?? null); }
      else if (key === "space") { this.searchQuery += " "; this.invalidateRows(); this.selectId(selectedRowKey ?? null); }
      else if (key.length === 1 && key.charCodeAt(0) >= 32) { this.searchQuery += key; this.invalidateRows(); this.selectId(selectedRowKey ?? null); }
      this.requestRender();
      return;
    }

    if (key === "escape" && this.draft.markId) {
      this.draft.markId = null;
      this.draft.message = "Range cancelled";
      this.requestRender();
      return;
    }

    if (key === "escape" || key === "ctrl+c" || key === "ctrl+d" || key === "q") {
      this.close({ action: "quit" });
      return;
    }
    if (key === "u") { this.draft.undo(); this.invalidateDraft(); this.selectId(this.draft.viewSelectedId); changed = true; }
    else if (key === "U") { this.draft.redo(); this.invalidateDraft(); this.selectId(this.draft.viewSelectedId); changed = true; }
    else if (key === "up" || key === "k") { this.move(-1); changed = true; }
    else if (key === "down" || key === "j") { this.move(1); changed = true; }
    else if (key === "pageup") { this.move(-10); changed = true; }
    else if (key === "pagedown") { this.move(10); changed = true; }
    else if (selectedId && key === "ctrl+left") {
      if (!isVirtual && selectedRow?.foldable) { this.foldedIds.add(selectedId); this.invalidateRows(); this.selectId(selectedId); changed = true; }
    }
    else if (selectedId && key === "ctrl+right") {
      if (!isVirtual && this.foldedIds.delete(selectedId)) { this.invalidateRows(); this.selectId(selectedId); changed = true; }
    }
    else if (key === "/") { this.searchMode = true; this.draft.message = "Search: type to filter, Enter to keep, Esc to stop editing search"; changed = true; }
    else if (key === "i") { this.includeSubbranches = !this.includeSubbranches; this.draft.message = this.includeSubbranches ? "Range operations include subbranches" : "Range operations use main path only"; changed = true; }
    else if (key === "f") { this.filterMode = this.filterMode === "default" ? "show-tools" : this.filterMode === "show-tools" ? "user-only" : this.filterMode === "user-only" ? "labeled-only" : this.filterMode === "labeled-only" ? "all" : "default"; this.draft.message = `Filter: ${this.filterLabel(this.filterMode)}`; this.invalidateRows(); this.selectId(selectedRowKey ?? this.draft.targetLeafId); changed = true; }
    else if (selectedRow && key === "o") {
      const summaryId = selectedRow.virtual?.summaryEntryId ?? (isSummaryEntry(selectedRow.entry) ? selectedRow.entry.id : undefined);
      if (summaryId) {
        if (this.expandedSummaryIds.has(summaryId)) this.expandedSummaryIds.delete(summaryId);
        else this.expandedSummaryIds.add(summaryId);
        this.draft.message = this.expandedSummaryIds.has(summaryId) ? "Summary opened" : "Summary closed";
        this.invalidateRows();
        this.selectId(summaryId);
      } else this.draft.message = "Selected row is not a summary";
      changed = true;
    }
    else if (selectedRowKey && key === "v") {
      if (this.draft.markId) { this.draft.markId = null; this.draft.message = "Range cancelled"; }
      else { this.draft.markId = selectedRowKey; this.draft.message = `Range started at ${selectedId}; move cursor, then y to copy or c to cut`; }
      changed = true;
    } else if (selectedRowKey && selectedId && key === "y") {
      this.draft.checkpoint();
      this.draft.copyRange(selectedId, this.foldedIds, this.operationRangeEntries(rows, selectedRowKey), this.includeSubbranches ? "preserve" : "linear");
      changed = true;
    } else if (selectedId && key === "c") {
      if (isVirtual) changed = virtualReadOnly();
      else { this.draft.checkpoint(); this.draft.cutRange(selectedId, this.foldedIds, this.operationRangeEntries(rows, selectedRowKey), this.includeSubbranches ? "preserve" : "linear"); this.invalidateDraft(); this.clampSelection(); changed = true; }
    } else if (selectedId && key === "p") {
      if (isVirtual) { this.draft.message = "Select a real tree row to paste"; changed = true; }
      else { this.draft.checkpoint(); const pastedId = this.draft.markId ? this.draft.replaceRangeWithClipboard(selectedId, this.foldedIds, this.operationRangeEntries(rows, selectedRowKey)) : this.draft.pasteAfter(selectedId, false); this.invalidateDraft(); this.selectId(pastedId); changed = true; }
    } else if (selectedId && key === "P") {
      if (isVirtual) this.draft.message = "Select a real tree row to paste";
      else if (this.draft.markId) this.draft.message = "P is disabled while a range is active; use p to replace the range or v to cancel";
      else { this.draft.checkpoint(); const pastedId = this.draft.pasteAfter(selectedId, true); this.invalidateDraft(); this.selectId(pastedId); }
      changed = true;
    } else if (selectedId && key === "C") {
      if (isVirtual) { this.draft.message = "Select a real tree row to compact before"; changed = true; }
      else if (!isNormalMessageEntry(selectedEntry)) { this.draft.message = "Select a user/assistant message to compact before"; changed = true; }
      else { this.draft.viewSelectedId = selectedId; this.close({ action: "compact", id: selectedId }); return; }
    } else if (selectedId && key === "d") {
      if (isVirtual) changed = virtualReadOnly();
      else { this.draft.checkpoint(); this.draft.deleteRangeOrEntry(selectedId, this.foldedIds, this.operationRangeEntries(rows, selectedRowKey)); this.invalidateDraft(); this.clampSelection(); changed = true; }
    } else if (selectedId && key === "D") {
      if (isVirtual) changed = virtualReadOnly();
      else { this.draft.checkpoint(); this.draft.deleteSubtree(selectedId); this.invalidateDraft(); this.clampSelection(); changed = true; }
    } else if (selectedId && key === "t") {
      if (isVirtual) changed = virtualReadOnly();
      else { this.draft.checkpoint(); this.draft.pruneToolOutputs(selectedId, this.foldedIds, this.operationRangeEntries(rows, selectedRowKey)); this.invalidateDraft(); changed = true; }
    } else if (selectedId && (key === "b" || key === "return")) {
      if (isVirtual) { this.draft.message = "Virtual summary rows cannot be the current location"; changed = true; }
      else { this.draft.checkpoint(); this.draft.targetLeafId = selectedId; this.draft.dirty = true; this.draft.message = `Current location set to ${selectedId}`; this.invalidateRows(); this.selectId(selectedId); changed = true; }
    } else if (selectedId && key === "e") {
      if (isVirtual) { this.draft.message = "Virtual summary rows are read-only"; changed = true; }
      else { this.draft.viewSelectedId = selectedId; this.close({ action: "edit", id: selectedId }); return; }
    } else if (selectedId && key === "L") {
      if (isVirtual) { this.draft.message = "Virtual summary rows cannot be labeled"; changed = true; }
      else { this.draft.viewSelectedId = selectedId; this.close({ action: "label", id: selectedId }); return; }
    }

    if (changed) this.requestRender();
  }

  private invalidateRows(): void {
    this.rowsCache = undefined;
    this.allRowsCache = undefined;
  }

  private invalidateDraft(): void {
    this.invalidateRows();
    this.dataCache = undefined;
    this.contextCache = undefined;
  }

  private data() {
    return this.dataCache ??= { byId: entryMap(this.draft.entries), children: childrenMap(this.draft.entries), labels: buildLabels(this.draft.entries) };
  }

  private contextPercents(): Map<string, number> {
    const window = this.ctx.model?.contextWindow ?? 0;
    if (!this.contextCache || this.contextCache.window !== window) this.contextCache = { window, percentages: contextPercentByEntry(this.draft.entries, window) };
    return this.contextCache.percentages;
  }

  private visibleRows(): TreeRow[] {
    if (!this.rowsCache) {
      const base = visibleRows(this.draft.entries, this.filterMode, this.foldedIds, this.searchQuery, this.draft.targetLeafId);
      this.rowsCache = expandSummaryRows(base, this.draft.entries, this.expandedSummaryIds);
    }
    return this.rowsCache;
  }

  private visibleRangeEntries(rows = this.visibleRows(), selectedKey = rows[this.selected] ? rowKey(rows[this.selected]) : undefined): Entry[] {
    if (!selectedKey) return [];
    const selectedRow = rows.find((row) => rowKey(row) === selectedKey);
    if (!this.draft.markId) return selectedRow && !selectedRow.virtual?.missing ? [selectedRow.entry] : [];
    const ia = rows.findIndex((row) => rowKey(row) === this.draft.markId);
    const ib = rows.findIndex((row) => rowKey(row) === selectedKey);
    if (ia < 0 || ib < 0) return selectedRow && !selectedRow.virtual ? this.draft.range(this.draft.markId, selectedRow.entry.id) : [];
    const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
    return rows.slice(lo, hi + 1).filter((row) => !row.virtual?.missing).map((row) => row.entry);
  }

  private mainPathRangeEntries(rows = this.visibleRows(), selectedKey = rows[this.selected] ? rowKey(rows[this.selected]) : undefined): Entry[] {
    if (!selectedKey) return [];
    const selectedRow = rows.find((row) => rowKey(row) === selectedKey);
    if (selectedRow?.virtual) return this.visibleRangeEntries(rows, selectedKey);
    const selectedId = selectedRow?.entry.id;
    if (!selectedId) return [];
    if (!this.draft.markId) return [selectedRow.entry];
    const byId = this.data().byId;
    const pathToRoot = (id: string): string[] => {
      const path: string[] = [];
      const seen = new Set<string>();
      let cur = byId.get(id);
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        path.push(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return path.reverse();
    };
    const markPath = pathToRoot(this.draft.markId);
    const selectedPath = pathToRoot(selectedId);
    let common = 0;
    while (common < markPath.length && common < selectedPath.length && markPath[common] === selectedPath[common]) common++;
    const mainIds = new Set([...markPath.slice(common - 1), ...selectedPath.slice(common - 1)]);
    const fullRows = this.allRowsCache ??= visibleRows(this.draft.entries, "all", new Set(), "", this.draft.targetLeafId);
    const out = fullRows.map((row) => row.entry).filter((entry) => mainIds.has(entry.id));
    return out.length ? out : this.visibleRangeEntries(rows, selectedKey);
  }

  private operationRangeEntries(rows = this.visibleRows(), selectedKey = rows[this.selected] ? rowKey(rows[this.selected]) : undefined): Entry[] {
    const base = !this.includeSubbranches ? this.mainPathRangeEntries(rows, selectedKey) : this.visibleRangeEntries(rows, selectedKey);
    if (!this.includeSubbranches) return base;
    const ids = new Set<string>();
    const children = this.data().children;
    const pending = [...base];
    while (pending.length) {
      const entry = pending.pop()!;
      if (ids.has(entry.id)) continue;
      ids.add(entry.id);
      for (const child of children.get(entry.id) ?? []) pending.push(child);
    }
    return this.draft.entries.filter((entry) => ids.has(entry.id));
  }

  private clampSelection(): void {
    const rows = this.visibleRows();
    this.selected = clampSelectedIndex(this.selected, rows.length);
    this.scroll = selectionOffset(this.selected, this.scroll, rows.length, this.pageSize());
    this.draft.viewSelectedId = rows[this.selected] ? rowKey(rows[this.selected]) : null;
  }

  private selectId(id: string | null): void {
    const rows = this.visibleRows();
    const indexes = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) indexes.set(rowKey(rows[i]), i);
    let current = id;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      const index = indexes.get(current);
      if (index !== undefined) { this.selected = index; break; }
      seen.add(current);
      current = this.data().byId.get(current)?.parentId ?? null;
    }
    this.clampSelection();
  }

  private move(delta: number): void {
    this.selected += delta;
    this.clampSelection();
  }

  private pageSize(): number {
    return this.renderedPageSize ?? this.overlayRowBudget({
      maxRows: TREE_EDIT_MAX_ROWS,
      minRows: TREE_EDIT_MIN_ROWS,
      reservedRows: TREE_EDIT_RESERVED_ROWS,
      maxHeightRatio: TREE_EDIT_OVERLAY_MAX_HEIGHT_RATIO,
    });
  }

  private filterLabel(mode: FilterMode): string {
    return mode;
  }

  private treePrefix(row: TreeRow, maxWidth: number): string {
    const displayIndent = row.multipleRoots ? Math.max(0, row.depth - 1) : row.depth;
    const connector = row.showConnector && !row.isVirtualRootChild;
    const connectorPosition = connector ? displayIndent - 1 : -1;
    const totalChars = displayIndent * 3;
    // Deep branches can have thousands of gutter columns. Build only the tail
    // that fits, leaving room for message text instead of drawing invisible padding.
    const clipped = totalChars > maxWidth;
    const chars: string[] = clipped ? ["… "] : [];
    const start = Math.max(0, totalChars - Math.max(0, maxWidth - (clipped ? 2 : 0)));
    const gutters = new Map(row.gutters.map((gutter) => [gutter.position, gutter.show]));

    for (let i = start; i < totalChars; i++) {
      const level = Math.floor(i / 3);
      const posInLevel = i % 3;
      const gutter = gutters.get(level);
      if (gutter !== undefined) {
        chars.push(posInLevel === 0 ? (gutter ? "│" : " ") : " ");
      } else if (connector && level === connectorPosition) {
        if (posInLevel === 0) chars.push(row.isLast ? "└" : "├");
        else if (posInLevel === 1) chars.push(row.folded ? "⊞" : row.foldable ? "⊟" : "─");
        else chars.push(" ");
      } else {
        chars.push(" ");
      }
    }

    const prefix = chars.join("");
    const showsFoldInConnector = row.showConnector && !row.isVirtualRootChild;
    const foldMarker = !showsFoldInConnector && row.foldable ? (row.folded ? "⊞ " : "⊟ ") : "";
    return prefix + foldMarker;
  }


  private displayText(row: TreeRow, selected: boolean): string {
    const entry = row.entry;
    const th = this.theme;
    const normalize = (s: string) => compactLine(s);
    let result = "";
    if (row.virtual?.missing) {
      result = th.fg("warning", `[missing source entry ${row.virtual.sourceEntryId}]`);
      return selected ? th.bold(result) : result;
    }
    if (entry.type === "message") {
      const msg = entry.message;
      if (msg?.role === "user") result = th.fg("accent", "user: ") + normalize(textFromContent(msg.content));
      else if (msg?.role === "assistant") {
        const text = normalize(textFromContent(msg.content));
        result = th.fg("success", "assistant: ") + (text || th.fg("muted", msg.errorMessage || (msg.stopReason === "aborted" ? "(aborted)" : "(no content)")));
      } else result = th.fg("dim", `[${msg?.role || "message"}] ${normalize(entryText(entry))}`);
    } else if (entry.type === "branch_summary") result = th.fg("warning", "[branch summary]: ") + normalize(entry.summary || "");
    else if (entry.type === "compaction") result = th.fg("borderAccent", `[compaction: ${Math.round((entry.tokensBefore || 0) / 1000)}k tokens]`);
    else if (isSummaryEntry(entry)) {
      const count = summarySourceIds(entry).length;
      const marker = this.expandedSummaryIds.has(entry.id) ? "▾" : "▸";
      result = th.fg("warning", `${marker} [summary: ${count} entr${count === 1 ? "y" : "ies"}] `) + th.fg("warning", normalize(textFromContent(entry.content)).replace(/^Summary of selected tree range:\s*/i, ""));
    }
    else if (entry.type === "custom_message") result = th.fg("customMessageLabel", `[${entry.customType}]: `) + normalize(textFromContent(entry.content));
    else result = th.fg("dim", `[${entryKind(entry)}] ${normalize(entryText(entry))}`);
    if (row.virtual?.kind === "summary-source") result = th.fg("warning", stripAnsi(result));
    return selected ? th.bold(result) : result;
  }

  render(width: number): string[] {
    this.ensureFlashAnimation();
    // Fill the whole overlay width so underlying widgets do not show through
    // beside the tree-edit box.
    const bodyWidth = Math.max(40, width);
    const th = this.theme;
    const rows = this.visibleRows();
    const allCount = this.draft.entries.length;
    const labels = this.data().labels;
    const selectedRow = rows[this.selected];
    const selectedId = selectedRow?.entry.id;
    const selectedKey = selectedRow ? rowKey(selectedRow) : undefined;
    const visibleRange = this.draft.markId && selectedKey ? this.visibleRangeEntries(rows, selectedKey) : [];
    const operationRange = this.draft.markId && selectedKey ? this.operationRangeEntries(rows, selectedKey) : [];
    const rangeIds = new Set(operationRange.map((e) => e.id));
    const visibleRangeIds = new Set(visibleRange.map((entry) => entry.id));
    const hiddenFoldedCount = operationRange.filter((entry) => !visibleRangeIds.has(entry.id)).length;
    const flashIds = new Set<string>(this.draft.flashEntryIds);
    const highlightIds = new Set<string>(this.draft.highlightEntryIds);
    const contextPercents = this.contextPercents();
    const lines: string[] = [];
    const rangeStatus = operationRange.length ? `${operationRange.length} selected${hiddenFoldedCount ? ` (${visibleRange.length} visible + ${hiddenFoldedCount} subbranch)` : ""}` : "none";
    const branchStatus = this.includeSubbranches ? th.fg("warning", "include branches") : th.fg("accent", "main path");
    const searchStatus = this.searchQuery ? ` ${th.fg("dim", "|")} search: ${th.fg(this.searchMode ? "warning" : "accent", this.searchQuery)}` : "";
    const selectedCtx = selectedId ? contextPercents.get(selectedId) : undefined;
    const ctxStatus = selectedCtx === undefined ? "" : ` ${th.fg("dim", "|")} ${th.fg(selectedCtx >= 90 ? "error" : selectedCtx >= 75 ? "warning" : "muted", `ctx ${selectedCtx}%`)}`;
    const lastStatus = this.draft.lastOperation ? ` ${th.fg("dim", "|")} last: ${th.fg("accent", this.draft.lastOperation)}` : "";
    lines.push(`${this.draft.dirty ? th.fg("warning", "modified") : th.fg("success", "clean")} ${th.fg("dim", "|")} filter: ${th.fg("accent", this.filterLabel(this.filterMode))}${searchStatus}${ctxStatus} ${th.fg("dim", "|")} branches: ${branchStatus} ${th.fg("dim", "|")} clipboard: ${this.draft.clipboard ? th.fg("accent", this.draft.clipboard.label) : th.fg("dim", "empty")} ${th.fg("dim", "|")} range: ${this.draft.markId ? th.fg("accent", rangeStatus) : th.fg("dim", "none")} ${th.fg("dim", "|")} current location: ${this.draft.targetLeafId ?? "root"}${lastStatus}`);
    lines.push(...wrapHelp(HELP_ITEMS, bodyWidth - 4, th));
    if (this.draft.message) lines.push(th.fg(this.draft.message.toLowerCase().includes("cannot") || this.draft.message.toLowerCase().includes("error") ? "error" : "accent", this.draft.message));
    lines.push("");
    const terminalRows = this.terminalRows();
    this.renderedPageSize = terminalRows === undefined ? TREE_EDIT_MAX_ROWS : Math.max(1, Math.min(TREE_EDIT_MAX_ROWS, Math.floor(terminalRows * TREE_EDIT_OVERLAY_MAX_HEIGHT_RATIO) - Math.max(5, lines.length) - 3));
    if (this.centerOnFirstRender) {
      this.scroll = Math.max(0, Math.min(rows.length - this.pageSize(), this.selected - Math.floor(this.pageSize() / 2)));
      this.centerOnFirstRender = false;
    } else {
      this.scroll = selectionOffset(this.selected, this.scroll, rows.length, this.pageSize());
    }
    const visible = rows.slice(this.scroll, this.scroll + this.pageSize());
    for (let i = 0; i < visible.length; i++) {
      const real = this.scroll + i;
      const row = visible[i];
      const entry = row.entry;
      const selected = real === this.selected;
      const rowId = rowKey(row);
      const inRange = rangeIds.has(entry.id) || Boolean(this.draft.markId && visibleRangeIds.has(entry.id));
      const isMark = this.draft.markId === rowId;
      const isTarget = this.draft.targetLeafId === entry.id;
      const isFlashing = this.flashOn && flashIds.has(entry.id);
      const isHighlighted = highlightIds.has(entry.id);
      const cursor = selected ? th.fg("accent", "› ") : "  ";
      const label = labels.get(entry.id);
      const labelText = label ? th.fg("warning", `[${label}] `) : "";
      const prefix = th.fg(row.virtual ? "warning" : "dim", this.treePrefix(row, Math.floor(bodyWidth / 3)));
      const pathMarker = row.virtual ? th.fg("warning", "• ") : isTarget ? th.fg("accent", "◆ ") : row.activePath ? th.fg("accent", "• ") : "";
      let line = `${cursor}${prefix}${pathMarker}${labelText}${this.displayText(row, selected)}`;
      if (selected) line = th.bg("selectedBg", line);
      else if (isFlashing && this.draft.flashKind === "cut") line = th.bg("toolErrorBg", line);
      else if (isFlashing) line = th.bg("toolPendingBg", line);
      else if ((inRange || isMark) && isHighlighted) line = th.bg("toolErrorBg", line);
      else if (isHighlighted && this.draft.highlightKind === "copy") line = th.bg("toolSuccessBg", line);
      else if (isHighlighted && this.draft.highlightKind === "prune") line = th.bg("toolSuccessBg", line);
      else if (isHighlighted && this.draft.highlightKind === "paste") line = th.bg("toolPendingBg", line);
      else if (inRange || isMark) line = th.bg("customMessageBg", line);
      lines.push(truncateToWidth(line, bodyWidth));
    }
    if (!rows.length) lines.push(th.fg("dim", "  No entries in current filter (press f)"));
    const minInnerHeight = Math.max(lines.length, this.pageSize() + 5);
    while (lines.length < minInnerHeight) lines.push("");
    const highlightStatus = this.draft.highlightEntryIds.length ? `${this.draft.highlightKind ?? "highlight"}: ${this.draft.highlightEntryIds.length} · ` : "";
    const exitHint = this.draft.dirty ? "q/Esc prompts to save or discard" : "q/Esc quits";
    lines.push(th.fg("dim", `(${rows.length ? this.selected + 1 : 0}/${rows.length}) [${this.filterLabel(this.filterMode)}] ${highlightStatus}${allCount !== rows.length ? `${allCount - rows.length} hidden · ` : ""}${exitHint}`));
    return boxLines(lines, Math.max(40, bodyWidth), th, { title: " tree-edit " });
  }
}

export const __test = { TreeEditComponent };

async function saveDraft(sessionFile: string, draft: DraftSession, ctx: Ctx): Promise<void> {
  draft.cleanupLabels();
  const errors = validateDraft(draft.header, draft.entries);
  if (errors.length) throw new Error(`Draft validation failed:\n${errors.slice(0, 10).join("\n")}`);
  if (draft.targetLeafId && !draft.entries.some((entry) => entry.id === draft.targetLeafId)) throw new Error(`Draft target leaf is missing: ${draft.targetLeafId}`);

  const header = clone(draft.header);
  setSessionHeaderLeaf(header, draft.targetLeafId);
  const records = makeEffectiveLeafLast([header, ...draft.entries], draft.targetLeafId);
  const backupDir = ensurePipSubdir("backup", "tree-edit");
  const backup = backupSessionFile(sessionFile, "tree-edit", { backupDir });
  writeSessionRecordsAtomic(sessionFile, records);
  cleanupBackups(backupDir);

  await ctx.switchSession(sessionFile, {
    withSession: async (nextCtx: Ctx) => {
      if (draft.targetLeafId) {
        try { await nextCtx.navigateTree(draft.targetLeafId, { summarize: false }); } catch {}
      }
      nextCtx.ui.notify(`tree-edit saved (${basename(backup)})`, "success");
    },
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("tree-edit", {
    description: "Open transactional session tree editor",
    handler: async (_args: string, ctx: Ctx) => {
      await ctx.waitForIdle?.();
      const sessionFile = ctx.sessionManager.getSessionFile?.();
      if (!sessionFile) {
        ctx.ui.notify("tree-edit requires a persisted session", "warning");
        return;
      }

      if (!hasTuiCustom(ctx)) {
        ctx.ui.notify("tree-edit requires interactive TUI", "warning");
        return;
      }

      const parsed = parseSessionFile(sessionFile);
      const draft = new DraftSession(parsed.header, parsed.entries, ctx.sessionManager.getLeafId?.() ?? null);

      while (true) {
        const result = await (ctx.ui.custom as any)((tui: any, theme: Theme, _kb: any, done: (result?: ExitResult) => void) => new TreeEditComponent(draft, ctx, tui, theme, done), {
          overlay: true,
          overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", minWidth: 90, margin: 1 },
        });

        if (result?.action === "edit") {
          draft.checkpoint();
          await draft.editEntry(result.id, ctx);
          continue;
        }
        if (result?.action === "compact") {
          await draft.compactBefore(result.id, ctx);
          continue;
        }
        if (result?.action === "label") {
          draft.checkpoint();
          await draft.editLabel(result.id, ctx);
          continue;
        }

        if (!draft.dirty) return;

        const choice = await ctx.ui.select("Save tree-edit changes?", ["Quit without saving", "Save and quit", "Cancel"]);
        if (choice === "Cancel" || !choice) continue;
        if (choice === "Quit without saving") return;
        if (choice === "Save and quit") {
          await saveDraft(sessionFile, draft, ctx);
          return;
        }
      }
    },
  });
}
