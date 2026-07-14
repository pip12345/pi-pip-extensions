import { randomUUID } from "node:crypto";
import { generateSummary } from "@earendil-works/pi-coding-agent";
import { setTextContent } from "pip-common";
import { EXT, type Clipboard, type Ctx, type DraftSnapshot, type Entry, type Header, type SummarySnapshotPolicy } from "./types.ts";
import { buildLabels, clone, createSummaryEntry, descendantsOf, entryKind, entryMap, estimateContextTokensForEntry, flattenEntries, isNormalMessageEntry, messagesFromEntries, nearestExistingParent, pathBetween, pathToRoot, snapshotEntries, textFromContent } from "./tree.ts";

const DEFAULT_SUMMARY_SETTINGS: SummarySnapshotPolicy = { summarySnapshots: true, snapshotToolResults: "truncated", toolResultTruncation: 20000 };

function newId(existing: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) {
      existing.add(id);
      return id;
    }
  }
  const id = randomUUID();
  existing.add(id);
  return id;
}

export class DraftSession {
  header: Header;
  entries: Entry[];
  dirty = false;
  targetLeafId: string | null;
  message = "";
  clipboard: Clipboard | null = null;
  markId: string | null = null;
  viewSelectedId: string | null = null;
  flashEntryIds: string[] = [];
  flashNonce = 0;
  flashKind: "copy" | "cut" | "paste" | "summary" | null = null;
  highlightEntryIds: string[] = [];
  highlightKind: "copy" | "paste" | "summary" | null = null;
  lastOperation = "";
  private undoStack: DraftSnapshot[] = [];
  private redoStack: DraftSnapshot[] = [];

  constructor(header: Header, entries: Entry[], currentLeafId: string | null, private readonly summarySettings: () => SummarySnapshotPolicy = () => DEFAULT_SUMMARY_SETTINGS) {
    this.header = header;
    this.entries = entries;
    this.targetLeafId = currentLeafId ?? entries[entries.length - 1]?.id ?? null;
    this.viewSelectedId = this.targetLeafId;
  }

  private snapshot(): DraftSnapshot {
    return { entries: clone(this.entries), targetLeafId: this.targetLeafId, clipboard: clone(this.clipboard), markId: this.markId, dirty: this.dirty };
  }

  private restore(snapshot: DraftSnapshot): void {
    this.entries = clone(snapshot.entries);
    this.targetLeafId = snapshot.targetLeafId;
    this.clipboard = clone(snapshot.clipboard);
    this.markId = snapshot.markId;
    this.dirty = snapshot.dirty;
  }

  checkpoint(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  private highlightAddedFrom(before: Entry[]): void {
    const beforeIds = new Set(before.map((e) => e.id));
    const added = this.entries.filter((e) => !beforeIds.has(e.id)).map((e) => e.id);
    if (added.length) {
      this.highlightEntryIds = added;
      this.highlightKind = "paste";
      this.flashEntryIds = added;
      this.flashKind = "paste";
      this.flashNonce += 1;
      this.lastOperation = `redid ${added.length} added entr${added.length === 1 ? "y" : "ies"}`;
    }
  }

  undo(): void {
    const snapshot = this.undoStack.pop();
    if (!snapshot) {
      this.message = "Nothing to undo";
      return;
    }
    this.redoStack.push(this.snapshot());
    this.restore(snapshot);
    this.message = "Undid last draft change";
  }

  redo(): void {
    const snapshot = this.redoStack.pop();
    if (!snapshot) {
      this.message = "Nothing to redo";
      return;
    }
    const before = clone(this.entries);
    this.undoStack.push(this.snapshot());
    this.restore(snapshot);
    this.highlightAddedFrom(before);
    this.message = "Redid draft change";
  }

  rows() { return flattenEntries(this.entries); }
  ids() { return new Set(this.entries.map((e) => e.id)); }
  selectedFallback(): string | null { return this.entries[0]?.id ?? null; }

  range(a: string | null, b: string | null): Entry[] {
    if (!a || !b) return [];
    const path = pathBetween(this.entries, a, b);
    if (path) return path;
    const rows = this.rows().map((r) => r.entry);
    const ia = rows.findIndex((e) => e.id === a);
    const ib = rows.findIndex((e) => e.id === b);
    if (ia < 0 || ib < 0) return [];
    const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
    return rows.slice(lo, hi + 1);
  }

  cleanupLabels(): void {
    const ids = this.ids();
    this.entries = this.entries.filter((entry) => entry.type !== "label" || ids.has(entry.targetId));
  }

  deleteSingle(id: string): void {
    const target = this.entries.find((e) => e.id === id);
    if (!target) return;
    const parentId = target.parentId ?? null;
    for (const entry of this.entries) {
      if (entry.parentId === id) entry.parentId = parentId;
    }
    this.entries = this.entries.filter((entry) => entry.id !== id && !(entry.type === "label" && entry.targetId === id));
    if (this.markId === id) this.markId = null;
    if (this.targetLeafId === id) this.targetLeafId = parentId;
    this.cleanupLabels();
    this.dirty = true;
    this.message = `Deleted entry ${id}`;
  }

  deleteSubtree(id: string): void {
    const removed = descendantsOf(this.entries, id);
    removed.add(id);
    this.removeEntries(removed);
    this.message = `Deleted branch (${removed.size} entries)`;
  }

  removeEntries(removed: Set<string>): void {
    const oldEntries = this.entries;
    for (const entry of this.entries) {
      if (!removed.has(entry.id) && entry.parentId && removed.has(entry.parentId)) {
        entry.parentId = nearestExistingParent(oldEntries, removed, entry.parentId);
      }
    }
    this.entries = this.entries.filter((entry) => !removed.has(entry.id) && !(entry.type === "label" && removed.has(entry.targetId)));
    if (this.markId && removed.has(this.markId)) this.markId = null;
    if (this.targetLeafId && removed.has(this.targetLeafId)) this.targetLeafId = nearestExistingParent(oldEntries, removed, this.targetLeafId);
    this.cleanupLabels();
    this.dirty = true;
  }

  pruneToolOutputs(selectedId: string, foldedIds: Set<string> = new Set(), visibleBase?: Entry[]): void {
    const selected = this.selectedEntries(selectedId, foldedIds, visibleBase);
    const selectedIds = new Set(selected.map((entry) => entry.id));
    const toolCallIds = new Set<string>();
    for (const entry of selected) {
      const msg = entry.type === "message" ? entry.message : undefined;
      if (msg?.role === "toolResult" && msg.toolCallId) toolCallIds.add(String(msg.toolCallId));
      if (msg?.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === "toolCall" && block.id) toolCallIds.add(String(block.id));
        }
      }
    }

    const candidates = this.entries.filter((entry) => {
      const msg = entry.type === "message" ? entry.message : undefined;
      return msg?.role === "toolResult" && (selectedIds.has(entry.id) || (msg.toolCallId && toolCallIds.has(String(msg.toolCallId))));
    });

    let pruned = 0;
    let removedChars = 0;
    const prunedIds: string[] = [];
    const now = new Date().toISOString();
    for (const entry of candidates) {
      const msg = entry.message;
      if (msg?.details?.prunedBy === EXT) continue;
      const originalText = textFromContent(msg.content);
      const originalBytes = JSON.stringify(msg.content ?? "").length;
      const removed = Math.max(0, originalText.length);
      const stub = `[tool result pruned by ${EXT}: ${removed} chars removed from ${msg.toolName || "tool"}${msg.toolCallId ? ` call ${msg.toolCallId}` : ""}]`;
      msg.content = [{ type: "text", text: stub }];
      msg.details = { ...(msg.details ?? {}), prunedBy: EXT, prunedAt: now, originalBytes, originalTextChars: originalText.length, prunePolicy: "stub" };
      pruned++;
      removedChars += removed;
      prunedIds.push(entry.id);
    }

    this.markId = null;
    if (!pruned) {
      this.message = "No unpruned tool results in selection";
      return;
    }
    this.highlightEntryIds = prunedIds;
    this.highlightKind = "summary";
    this.flashEntryIds = prunedIds;
    this.flashKind = "summary";
    this.flashNonce += 1;
    this.dirty = true;
    this.lastOperation = `pruned ${pruned} tool result${pruned === 1 ? "" : "s"}`;
    this.message = `Pruned ${pruned} tool result${pruned === 1 ? "" : "s"} (${removedChars} chars removed)`;
  }

  selectedEntries(selectedId: string, foldedIds: Set<string> = new Set(), visibleBase?: Entry[]): Entry[] {
    const base = visibleBase ?? (this.markId ? this.range(this.markId, selectedId) : this.entries.filter((e) => e.id === selectedId));
    const selected = new Set(base.map((e) => e.id));
    for (const entry of base) {
      if (!foldedIds.has(entry.id)) continue;
      for (const childId of descendantsOf(this.entries, entry.id)) selected.add(childId);
    }
    return this.entries.filter((entry) => selected.has(entry.id));
  }

  attachedLabelEntries(targetIds: Set<string>): Entry[] {
    return this.entries.filter((entry) => entry.type === "label" && targetIds.has(entry.targetId));
  }

  copyRange(selectedId: string, foldedIds: Set<string> = new Set(), visibleBase?: Entry[], structure: "linear" | "preserve" = "preserve"): Entry[] {
    const entries = this.selectedEntries(selectedId, foldedIds, visibleBase);
    const targetIds = new Set(entries.map((e) => e.id));
    const copied = [...entries.filter((e) => e.type !== "label"), ...this.attachedLabelEntries(targetIds)].map(clone);
    if (!copied.length) {
      this.message = "Nothing to copy";
      return [];
    }
    this.clipboard = { kind: "entries", entries: copied, label: `${copied.length} entr${copied.length === 1 ? "y" : "ies"}`, structure };
    const sourceIds = entries.map((e) => e.id);
    (this.clipboard as any).sourceEntryIds = sourceIds;
    this.markId = null;
    this.flashEntryIds = sourceIds;
    this.flashKind = "copy";
    this.flashNonce += 1;
    this.highlightEntryIds = sourceIds;
    this.highlightKind = "copy";
    this.lastOperation = `copied ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;
    this.message = `Copied ${this.clipboard.label}`;
    return entries;
  }

  cutRange(selectedId: string, foldedIds: Set<string> = new Set(), visibleBase?: Entry[], structure: "linear" | "preserve" = "preserve"): void {
    const entries = this.copyRange(selectedId, foldedIds, visibleBase, structure);
    if (!entries.length) return;
    const removed = new Set(entries.map((e) => e.id));
    this.flashEntryIds = entries.map((e) => e.id);
    this.flashKind = "cut";
    this.flashNonce += 1;
    this.removeEntries(removed);
    this.highlightEntryIds = [];
    this.highlightKind = null;
    this.lastOperation = `cut ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;
    this.message = `Cut ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;
  }

  deleteRangeOrEntry(selectedId: string, foldedIds: Set<string> = new Set(), visibleBase?: Entry[]): void {
    if (this.markId) {
      const entries = this.selectedEntries(selectedId, foldedIds, visibleBase);
      if (!entries.length) {
        this.message = "Nothing to delete";
        return;
      }
      const removed = new Set(entries.map((e) => e.id));
      this.markId = null;
      this.removeEntries(removed);
      this.message = `Deleted ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;
      return;
    }
    this.deleteSingle(selectedId);
  }

  private buildPasteEntries(parentId: string | null): { added: Entry[]; lastParent: string | null } | null {
    if (!this.clipboard) {
      this.message = "Clipboard empty";
      return null;
    }
    const existing = this.ids();
    let lastParent = parentId;
    const now = new Date().toISOString();
    const added: Entry[] = [];
    if (this.clipboard.kind === "summary") {
      const id = newId(existing);
      added.push(createSummaryEntry(this.clipboard, id, lastParent, now));
      lastParent = id;
    } else {
      const idMap = new Map<string, string>();
      const sourceByNewId = new Map<string, Entry>();
      for (const src of this.clipboard.entries) {
        if (src.type === "label") continue;
        const copy = clone(src);
        idMap.set(src.id, newId(existing));
        copy.id = idMap.get(src.id)!;
        copy.timestamp = now;
        added.push(copy);
        sourceByNewId.set(copy.id, src);
      }
      if (this.clipboard.structure === "linear") {
        let previousParent = parentId;
        for (const copy of added) {
          copy.parentId = previousParent;
          previousParent = copy.id;
        }
      } else {
        for (const copy of added) {
          const original = sourceByNewId.get(copy.id);
          copy.parentId = original?.parentId && idMap.has(original.parentId) ? idMap.get(original.parentId)! : parentId;
        }
      }
      lastParent = added[added.length - 1]?.id ?? parentId;
      for (const src of this.clipboard.entries) {
        if (src.type !== "label" || !idMap.has(src.targetId)) continue;
        const copy = clone(src);
        copy.id = newId(existing);
        copy.parentId = lastParent;
        copy.targetId = idMap.get(src.targetId)!;
        copy.timestamp = now;
        added.push(copy);
        lastParent = copy.id;
      }
    }
    return added.length ? { added, lastParent } : null;
  }

  pasteAfter(selectedId: string | null, branch: boolean): string | null {
    const continuationChild = !branch && selectedId ? this.childOnContinuation(selectedId) : undefined;
    const built = this.buildPasteEntries(selectedId);
    if (!built) return null;
    if (continuationChild) continuationChild.parentId = built.lastParent;
    this.entries.push(...built.added);
    this.viewSelectedId = built.lastParent;
    const addedIds = built.added.map((e) => e.id);
    this.highlightEntryIds = addedIds;
    this.highlightKind = "paste";
    this.flashEntryIds = addedIds;
    this.flashKind = "paste";
    this.flashNonce += 1;
    if (this.clipboard?.kind === "entries") (this.clipboard as any).sourceEntryIds = [];
    this.dirty = true;
    this.lastOperation = `pasted ${built.added.length} entr${built.added.length === 1 ? "y" : "ies"}`;
    this.message = `Pasted ${built.added.length} entr${built.added.length === 1 ? "y" : "ies"}${branch ? " as new branch" : ""}`;
    return built.lastParent;
  }

  async compactBefore(selectedId: string, ctx: Ctx): Promise<string | null> {
    const selected = this.entries.find((entry) => entry.id === selectedId);
    if (!isNormalMessageEntry(selected)) {
      this.message = "Select a user/assistant message to compact before";
      return null;
    }

    const branch = pathToRoot(this.entries, selectedId);
    const selectedIndex = branch.findIndex((entry) => entry.id === selectedId);
    let previousCompactionIndex = -1;
    for (let i = Math.max(0, selectedIndex) - 1; i >= 0; i--) {
      if (branch[i].type === "compaction") {
        previousCompactionIndex = i;
        break;
      }
    }
    const compactedEntries = branch.slice(previousCompactionIndex + 1, Math.max(0, selectedIndex));
    if (!compactedEntries.length) {
      this.message = previousCompactionIndex >= 0 ? "Nothing since previous compaction to compact" : "Nothing before selected message to compact";
      return null;
    }
    const messages = messagesFromEntries(compactedEntries);
    if (!messages.length) {
      this.message = "No messages before selected message to compact";
      return null;
    }
    if (!ctx.model) {
      this.message = "No active model for compaction";
      return null;
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth?.ok) {
      this.message = auth?.error || "No API key for active model";
      return null;
    }

    ctx.ui.notify(`Compacting ${compactedEntries.length} entries before ${selectedId}...`, "info");
    const generated = (await generateSummary(
      messages,
      ctx.model,
      4096,
      auth.apiKey,
      auth.headers,
      ctx.signal,
      "Summarize the session entries before the selected message as a compaction checkpoint. Preserve user goals, constraints, decisions, file changes, commands run, errors, unresolved tasks, and current state. The selected message and later entries will remain after this summary.",
      undefined,
      "off"
    )).trim();
    const summary = await ctx.ui.editor("Review compaction summary", generated);
    if (!summary?.trim()) {
      this.message = "Compaction cancelled";
      return null;
    }

    const existing = this.ids();
    const id = newId(existing);
    const continuationChild = this.childOnContinuation(selectedId);
    const entry: Entry = {
      type: "compaction",
      id,
      parentId: selectedId,
      timestamp: new Date().toISOString(),
      summary: summary.trim(),
      firstKeptEntryId: selectedId,
      tokensBefore: compactedEntries.reduce((sum, entry) => sum + estimateContextTokensForEntry(entry), 0),
      details: { from: EXT, kind: "manual", compactedBeforeEntryId: selectedId, sourceEntryIds: compactedEntries.map((entry) => entry.id) },
    };
    if (continuationChild) continuationChild.parentId = id;
    this.entries.push(entry);
    this.viewSelectedId = id;
    this.highlightEntryIds = [id];
    this.highlightKind = "paste";
    this.flashEntryIds = [id];
    this.flashKind = "paste";
    this.flashNonce += 1;
    this.markId = null;
    this.dirty = true;
    this.lastOperation = `compacted ${compactedEntries.length} entr${compactedEntries.length === 1 ? "y" : "ies"}`;
    this.message = `Compacted ${compactedEntries.length} entr${compactedEntries.length === 1 ? "y" : "ies"} before ${selectedId}`;
    return id;
  }

  private childOnContinuation(parentId: string): Entry | undefined {
    const currentPathChild = this.childOnCurrentPath(parentId);
    if (currentPathChild) return currentPathChild;
    const children = this.entries
      .filter((entry) => entry.parentId === parentId && entry.type !== "label")
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    return children.length === 1 ? children[0] : undefined;
  }

  private childOnCurrentPath(parentId: string): Entry | undefined {
    if (!this.targetLeafId) return undefined;
    const byId = entryMap(this.entries);
    let cur = byId.get(this.targetLeafId);
    while (cur?.parentId) {
      if (cur.parentId === parentId) return cur;
      cur = byId.get(cur.parentId);
    }
    return undefined;
  }

  replaceRangeWithClipboard(selectedId: string, foldedIds: Set<string> = new Set(), visibleBase?: Entry[]): string | null {
    if (!this.markId) return this.pasteAfter(selectedId, false);
    const range = this.selectedEntries(selectedId, foldedIds, visibleBase);
    if (!range.length) {
      this.message = "No range to replace";
      return null;
    }
    const first = range[0];
    const removed = new Set(range.map((e) => e.id));
    const parentId = first.parentId ?? null;
    const built = this.buildPasteEntries(parentId);
    if (!built) return null;
    const rangeIds = new Set(range.map((e) => e.id));
    for (const entry of this.entries) {
      if (!removed.has(entry.id) && entry.parentId && rangeIds.has(entry.parentId)) {
        entry.parentId = built.lastParent;
      }
    }
    this.entries = this.entries.filter((entry) => !removed.has(entry.id) && !(entry.type === "label" && removed.has(entry.targetId)));
    this.entries.push(...built.added);
    this.markId = null;
    this.viewSelectedId = built.lastParent;
    const addedIds = built.added.map((e) => e.id);
    this.highlightEntryIds = addedIds;
    this.highlightKind = "paste";
    this.flashEntryIds = addedIds;
    this.flashKind = "paste";
    this.flashNonce += 1;
    if (this.clipboard?.kind === "entries") (this.clipboard as any).sourceEntryIds = [];
    this.cleanupLabels();
    this.lastOperation = `replaced ${range.length} with ${built.added.length}`;
    this.dirty = true;
    const snapshotWarning = this.clipboard?.kind === "summary" && !this.clipboard.snapshotPolicy.summarySnapshots ? " (summary snapshots off; originals may not be recoverable)" : "";
    this.message = `Replaced ${range.length} entr${range.length === 1 ? "y" : "ies"} with ${built.added.length}${snapshotWarning}`;
    return built.lastParent;
  }

  async editLabel(id: string, ctx: Ctx): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.type === "label") {
      this.message = "Cannot label this entry";
      return;
    }
    const labels = buildLabels(this.entries);
    const current = labels.get(id) ?? "";
    const value = await ctx.ui.input("Label for selected entry (empty clears)", current);
    if (value === undefined || value === null) {
      this.message = "Label edit cancelled";
      return;
    }
    const existing = this.ids();
    const label = String(value).trim() || undefined;
    this.entries.push({ type: "label", id: newId(existing), parentId: this.targetLeafId, timestamp: new Date().toISOString(), targetId: id, label });
    this.dirty = true;
    this.message = label ? `Label set: ${label}` : "Label cleared";
  }

  async editEntry(id: string, ctx: Ctx): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    let current: string | undefined;
    let apply: ((text: string) => void) | undefined;
    if (entry.type === "message") {
      const msg = entry.message;
      if (["user", "assistant", "toolResult", "custom"].includes(msg?.role)) {
        current = textFromContent(msg.content);
        apply = (text) => {
          setTextContent(msg, text);
          msg.details = { ...(msg.details ?? {}), editedBy: EXT, editedAt: new Date().toISOString() };
        };
      }
    } else if (entry.type === "custom_message") {
      current = textFromContent(entry.content);
      apply = (text) => { entry.content = text; entry.details = { ...(entry.details ?? {}), editedBy: EXT, editedAt: new Date().toISOString() }; };
    } else if (entry.type === "branch_summary" || entry.type === "compaction") {
      current = entry.summary || "";
      apply = (text) => { entry.summary = text; entry.details = { ...(entry.details ?? {}), editedBy: EXT, editedAt: new Date().toISOString() }; };
    }
    if (!apply || current === undefined) {
      this.message = `Cannot edit ${entry.type}`;
      return;
    }
    const text = await ctx.ui.editor(`Edit ${entryKind(entry)} ${id}`, current);
    if (typeof text !== "string" || text === current) {
      this.message = "Edit cancelled";
      return;
    }
    apply(text);
    this.dirty = true;
    this.message = `Edited ${id}`;
  }

  async summarizeToClipboard(selectedId: string, ctx: Ctx, foldedIds: Set<string> = new Set(), visibleBase?: Entry[]): Promise<void> {
    const entries = this.selectedEntries(selectedId, foldedIds, visibleBase);
    if (!entries.length) {
      this.message = "No range to summarize";
      return;
    }
    if (!ctx.model) {
      this.message = "No active model for AI summarization";
      return;
    }
    const messages = messagesFromEntries(entries);
    if (!messages.length) {
      this.message = "No messages in selected range to summarize";
      return;
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth?.ok) {
      this.message = auth?.error || "No API key for active model";
      return;
    }
    ctx.ui.notify(`Summarizing ${entries.length} entries...`, "info");
    let generated = await generateSummary(
      messages,
      ctx.model,
      4096,
      auth.apiKey,
      auth.headers,
      ctx.signal,
      "Summarize the selected session entries so this summary can be injected into another branch as context. Preserve decisions, constraints, file changes, commands run, errors, unresolved tasks, user preferences, and final state.",
      undefined,
      "off"
    );
    generated = generated.trim();
    const summary = await ctx.ui.editor("Review branch/range summary", generated);
    if (!summary?.trim()) {
      this.message = "Summarization cancelled";
      return;
    }
    const sourceIds = entries.map((e) => e.id);
    const snapshotPolicy = this.summarySettings();
    const sourceEntries = snapshotEntries(entries, snapshotPolicy);
    this.clipboard = { kind: "summary", summary: summary.trim(), sourceEntryIds: sourceIds, sourceEntries, label: `summary of ${entries.length}`, snapshotPolicy };
    this.flashEntryIds = sourceIds;
    this.flashKind = "summary";
    this.flashNonce += 1;
    this.highlightEntryIds = sourceIds;
    this.highlightKind = "summary";
    this.lastOperation = `summarized ${entries.length} entr${entries.length === 1 ? "y" : "ies"} to clipboard`;
    this.viewSelectedId = selectedId;
    this.message = `Copied ${this.clipboard.label}; move to target and press p/P to insert it`;
  }
}

