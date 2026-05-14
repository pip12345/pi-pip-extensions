import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { decodeKittyPrintable, matchesKey, parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { generateSummary } from "@earendil-works/pi-coding-agent";

type ExtensionAPI = any;
type Theme = any;
type Ctx = any;

type Header = { type: "session"; [key: string]: any };
type Entry = { type: string; id: string; parentId: string | null; timestamp: string; [key: string]: any };
type FileEntry = Header | Entry;
type Clipboard =
  | { kind: "entries"; entries: Entry[]; label: string }
  | { kind: "compaction"; summary: string; sourceEntryIds: string[]; label: string; tokensBefore: number };

type ExitResult = { action: "quit" } | { action: "edit"; id: string } | { action: "compact"; id: string } | { action: "label"; id: string };
type FilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";
type TreeRow = { entry: Entry; depth: number; isLast: boolean; gutters: boolean[]; showConnector: boolean; isVirtualRootChild: boolean; foldable: boolean; folded: boolean };
type DraftSnapshot = { entries: Entry[]; targetLeafId: string | null; clipboard: Clipboard | null; markId: string | null; dirty: boolean };

const EXT = "pi-tree-edit";
const HELP_ITEMS = [
  "j/k move", "Ctrl+←/→ fold/unfold",
  "f filter default/no-tools/user-only/labeled-only/all",
  "Enter/b set current location",
  "v start/cancel range",
  "y copy",
  "c cut",
  "C compact",
  "p paste after",
  "P paste as new branch",
  "d delete",
  "D delete branch",
  "e edit",
  "L edit label",
  "r rewind here",
  "u undo",
  "U redo",
  "q quit",
];
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function isEntry(value: FileEntry): value is Entry {
  return value.type !== "session";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function parseSessionFile(path: string): { header: Header; entries: Entry[]; raw: FileEntry[] } {
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
  const raw = lines.map((line) => JSON.parse(line)) as FileEntry[];
  const header = raw.find((entry) => entry.type === "session") as Header | undefined;
  if (!header) throw new Error("Session file has no header");
  return { header: clone(header), entries: raw.filter(isEntry).map(clone), raw };
}

function timestampForFile(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

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

function textFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n");
}

function setTextContent(message: any, text: string): boolean {
  if (!message) return false;
  if (typeof message.content === "string") {
    message.content = text;
    return true;
  }
  if (Array.isArray(message.content)) {
    let replaced = false;
    const next: any[] = [];
    for (const block of message.content) {
      if (block?.type === "text") {
        if (!replaced) {
          next.push({ ...block, text });
          replaced = true;
        }
      } else {
        next.push(block);
      }
    }
    if (!replaced) next.unshift({ type: "text", text });
    message.content = next;
    return true;
  }
  message.content = text;
  return true;
}

function entryText(entry: Entry): string {
  if (entry.type === "message") {
    const msg = entry.message;
    if (msg?.role === "toolResult") return `${msg.toolName || "tool"}: ${textFromContent(msg.content)}`;
    if (msg?.role === "bashExecution") return `${msg.command || "bash"}: ${msg.output || ""}`;
    return textFromContent(msg?.content);
  }
  if (entry.type === "custom_message") return textFromContent(entry.content);
  if (entry.type === "compaction") return entry.summary || "";
  if (entry.type === "branch_summary") return entry.summary || "";
  if (entry.type === "label") return `label ${entry.targetId}: ${entry.label || "(clear)"}`;
  if (entry.type === "model_change") return `${entry.provider}/${entry.modelId}`;
  if (entry.type === "thinking_level_change") return entry.thinkingLevel || "";
  if (entry.type === "custom") return `${entry.customType || "custom"} ${JSON.stringify(entry.data ?? {})}`;
  return "";
}

function entryKind(entry: Entry): string {
  if (entry.type === "message") return entry.message?.role || "message";
  return entry.type;
}

function hasTextContent(content: any): boolean {
  return textFromContent(content).trim().length > 0;
}

function isVisibleEntry(entry: Entry, mode: FilterMode, labels: Map<string, string>): boolean {
  if (mode === "all") return true;
  if (mode === "labeled-only") return labels.has(entry.id);
  if (mode === "user-only") return entry.type === "message" && entry.message?.role === "user";

  if (entry.type === "message" && entry.message?.role === "assistant") {
    const msg = entry.message;
    const isErrorOrAborted = msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
    if (!hasTextContent(msg.content) && !isErrorOrAborted) return false;
  }

  const isSettingsEntry = entry.type === "label" || entry.type === "custom" || entry.type === "model_change" || entry.type === "thinking_level_change" || entry.type === "session_info";
  if (mode === "no-tools") return !isSettingsEntry && !(entry.type === "message" && entry.message?.role === "toolResult");
  return !isSettingsEntry;
}

function compactLine(value: string): string {
  return value.replace(ANSI_RE, "").replace(/\s+/g, " ").trim();
}

function estimateTokensForEntries(entries: Entry[]): number {
  const chars = entries.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

function messagesFromEntries(entries: Entry[]): any[] {
  return entries.flatMap((entry) => entry.type === "message" && entry.message ? [entry.message] : []);
}

function buildLabels(entries: Entry[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "label") continue;
    if (entry.label) labels.set(entry.targetId, entry.label);
    else labels.delete(entry.targetId);
  }
  return labels;
}

function childrenMap(entries: Entry[]): Map<string | null, Entry[]> {
  const map = new Map<string | null, Entry[]>();
  for (const entry of entries) {
    const arr = map.get(entry.parentId) ?? [];
    arr.push(entry);
    map.set(entry.parentId, arr);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }
  return map;
}

function flattenEntries(entries: Entry[]): Array<{ entry: Entry }> {
  const children = childrenMap(entries);
  const out: Array<{ entry: Entry }> = [];
  const seen = new Set<string>();
  const visit = (entry: Entry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push({ entry });
    for (const child of children.get(entry.id) ?? []) visit(child);
  };
  for (const root of children.get(null) ?? []) visit(root);
  for (const entry of entries) if (!seen.has(entry.id)) visit(entry);
  return out;
}

function visibleRows(entries: Entry[], mode: FilterMode, foldedIds: Set<string> = new Set()): TreeRow[] {
  const flat = flattenEntries(entries);
  const byId = entryMap(entries);
  const labels = buildLabels(entries);
  const visible = flat.filter((row) => isVisibleEntry(row.entry, mode, labels));
  const visibleIds = new Set(visible.map((row) => row.entry.id));
  const visibleChildren = new Map<string | null, Entry[]>();
  visibleChildren.set(null, []);

  const nearestVisibleParent = (entry: Entry): string | null => {
    let parentId = entry.parentId;
    while (parentId) {
      if (visibleIds.has(parentId)) return parentId;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return null;
  };

  for (const row of visible) {
    const parentId = nearestVisibleParent(row.entry);
    const siblings = visibleChildren.get(parentId) ?? [];
    siblings.push(row.entry);
    visibleChildren.set(parentId, siblings);
  }

  const out: TreeRow[] = [];
  const seen = new Set<string>();
  const visit = (entry: Entry, indent: number, justBranched: boolean, showConnector: boolean, isLast: boolean, gutters: boolean[], isVirtualRootChild: boolean) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    const kids = visibleChildren.get(entry.id) ?? [];
    const foldable = kids.length > 0;
    const folded = foldedIds.has(entry.id) && foldable;
    out.push({ entry, depth: indent, isLast, gutters, showConnector, isVirtualRootChild, foldable, folded });
    if (folded) return;

    const multipleChildren = kids.length > 1;
    let childIndent: number;
    if (multipleChildren) childIndent = indent + 1;
    else if (justBranched && indent > 0) childIndent = indent + 1;
    else childIndent = indent;

    const connectorDisplayed = showConnector && !isVirtualRootChild;
    const currentDisplayIndent = indent;
    const connectorPosition = Math.max(0, currentDisplayIndent - 1);
    const childGutters = connectorDisplayed ? [...gutters, !isLast] : gutters;

    for (let i = 0; i < kids.length; i++) {
      const childIsLast = i === kids.length - 1;
      visit(kids[i], childIndent, multipleChildren, multipleChildren, childIsLast, childGutters, false);
    }
  };

  const roots = visibleChildren.get(null) ?? [];
  const multipleRoots = roots.length > 1;
  for (let i = 0; i < roots.length; i++) {
    visit(roots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, i === roots.length - 1, [], multipleRoots);
  }
  for (const row of visible) if (!seen.has(row.entry.id)) visit(row.entry, 0, false, false, true, [], false);
  return out;
}

function descendantsOf(entries: Entry[], id: string): Set<string> {
  const children = childrenMap(entries);
  const out = new Set<string>();
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) {
    const entry = stack.pop()!;
    if (out.has(entry.id)) continue;
    out.add(entry.id);
    stack.push(...(children.get(entry.id) ?? []));
  }
  return out;
}

function entryMap(entries: Entry[]): Map<string, Entry> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

function pathBetween(entries: Entry[], a: string, b: string): Entry[] | null {
  const byId = entryMap(entries);
  const pathToRoot = (id: string): Entry[] => {
    const path: Entry[] = [];
    const seen = new Set<string>();
    let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return path;
  };
  const pa = pathToRoot(a);
  const pb = pathToRoot(b);
  const ia = pa.findIndex((e) => e.id === b);
  if (ia >= 0) return pa.slice(ia);
  const ib = pb.findIndex((e) => e.id === a);
  if (ib >= 0) return pb.slice(ib);
  return null;
}

function nearestExistingParent(original: Entry[], removed: Set<string>, id: string | null): string | null {
  const byId = entryMap(original);
  let cur = id ? byId.get(id) : undefined;
  while (cur) {
    if (!removed.has(cur.id)) return cur.id;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return null;
}

function validateDraft(header: Header, entries: Entry[]): string[] {
  const errors: string[] = [];
  if (!header || header.type !== "session") errors.push("Missing session header");
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.id) errors.push(`Entry without id (${entry.type})`);
    if (ids.has(entry.id)) errors.push(`Duplicate id ${entry.id}`);
    ids.add(entry.id);
  }
  for (const entry of entries) {
    if (entry.parentId !== null && !ids.has(entry.parentId)) errors.push(`${entry.id} has missing parent ${entry.parentId}`);
    if (entry.type === "label" && !ids.has(entry.targetId)) errors.push(`${entry.id} labels missing target ${entry.targetId}`);
  }
  const byId = entryMap(entries);
  for (const entry of entries) {
    const seen = new Set<string>();
    let cur: Entry | undefined = entry;
    while (cur) {
      if (seen.has(cur.id)) {
        errors.push(`Cycle detected at ${cur.id}`);
        break;
      }
      seen.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return errors;
}

function normalizeInputKey(data: string): string {
  if (matchesKey(data, "escape") || data === "\u001b") return "escape";
  if (matchesKey(data, "ctrl+c") || data === "\u0003") return "ctrl+c";
  if (matchesKey(data, "up") || data === "\u001b[A") return "up";
  if (matchesKey(data, "down") || data === "\u001b[B") return "down";
  if (data === "\u001b[1;5D" || data === "\u001b[5D") return "ctrl+left";
  if (data === "\u001b[1;5C" || data === "\u001b[5C") return "ctrl+right";
  if (matchesKey(data, "pageUp") || data === "\u001b[5~") return "pageup";
  if (matchesKey(data, "pageDown") || data === "\u001b[6~") return "pagedown";
  if (matchesKey(data, "return") || data === "\r") return "return";
  const parsed = parseKey(data);
  if (parsed) {
    if (parsed.startsWith("shift+") && parsed.length === "shift+q".length) return parsed.slice("shift+".length).toUpperCase();
    return parsed.toLowerCase();
  }
  const printable = decodeKittyPrintable(data);
  if (printable?.length === 1) return printable;
  if (data.length === 1) return data;
  return data;
}

function padAnsi(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}

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

function box(lines: string[], width: number, title: string, theme: Theme): string[] {
  const inner = Math.max(40, width - 2);
  const t = truncateToWidth(` ${title} `, inner);
  const left = "─".repeat(Math.floor(Math.max(0, inner - visibleWidth(t)) / 2));
  const right = "─".repeat(Math.max(0, inner - visibleWidth(t) - left.length));
  const out = [theme.fg("border", `╭${left}`) + theme.fg("accent", t) + theme.fg("border", `${right}╮`)];
  for (const line of lines) out.push(theme.fg("border", "│") + padAnsi(truncateToWidth(line, inner, "…", true), inner) + theme.fg("border", "│"));
  out.push(theme.fg("border", `╰${"─".repeat(inner)}╯`));
  return out;
}

class DraftSession {
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
  highlightEntryIds: string[] = [];
  highlightUntil = 0;
  private undoStack: DraftSnapshot[] = [];
  private redoStack: DraftSnapshot[] = [];

  constructor(header: Header, entries: Entry[], currentLeafId: string | null) {
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
      this.highlightUntil = Date.now() + 3000;
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

  redoFrom(id: string): void {
    const removed = descendantsOf(this.entries, id);
    this.entries = this.entries.filter((entry) => !removed.has(entry.id) && !(entry.type === "label" && removed.has(entry.targetId)));
    this.targetLeafId = id;
    this.cleanupLabels();
    this.dirty = true;
    this.highlightEntryIds = [id];
    this.highlightUntil = Date.now() + 3000;
    this.message = `Rewound to ${id}: removed ${removed.size} later entr${removed.size === 1 ? "y" : "ies"}`;
  }

  selectedEntries(selectedId: string, foldedIds: Set<string> = new Set()): Entry[] {
    const base = this.markId ? this.range(this.markId, selectedId) : this.entries.filter((e) => e.id === selectedId);
    const selected = new Set(base.map((e) => e.id));
    for (const entry of base) {
      if (!foldedIds.has(entry.id)) continue;
      for (const childId of descendantsOf(this.entries, entry.id)) selected.add(childId);
    }
    const selectedIds = selected;
    return this.entries.filter((entry) => selectedIds.has(entry.id));
  }

  attachedLabelEntries(targetIds: Set<string>): Entry[] {
    return this.entries.filter((entry) => entry.type === "label" && targetIds.has(entry.targetId));
  }

  copyRange(selectedId: string, foldedIds: Set<string> = new Set()): Entry[] {
    const entries = this.selectedEntries(selectedId, foldedIds);
    const targetIds = new Set(entries.map((e) => e.id));
    const copied = [...entries.filter((e) => e.type !== "label"), ...this.attachedLabelEntries(targetIds)].map(clone);
    if (!copied.length) {
      this.message = "Nothing to copy";
      return [];
    }
    this.clipboard = { kind: "entries", entries: copied, label: `${copied.length} entr${copied.length === 1 ? "y" : "ies"}` };
    (this.clipboard as any).sourceEntryIds = entries.map((e) => e.id);
    this.markId = null;
    this.flashEntryIds = entries.map((e) => e.id);
    this.flashNonce += 1;
    this.message = `Copied ${this.clipboard.label}`;
    return entries;
  }

  cutRange(selectedId: string, foldedIds: Set<string> = new Set()): void {
    const entries = this.copyRange(selectedId, foldedIds);
    if (!entries.length) return;
    const removed = new Set(entries.map((e) => e.id));
    this.removeEntries(removed);
    this.message = `Cut ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;
  }

  deleteRangeOrEntry(selectedId: string, foldedIds: Set<string> = new Set()): void {
    if (this.markId) {
      const entries = this.selectedEntries(selectedId, foldedIds);
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
    if (this.clipboard.kind === "compaction") {
      const id = newId(existing);
      added.push({ type: "compaction", id, parentId: lastParent, timestamp: now, summary: this.clipboard.summary, firstKeptEntryId: id, tokensBefore: this.clipboard.tokensBefore, details: { from: EXT, sourceEntryIds: this.clipboard.sourceEntryIds }, fromHook: true });
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
      for (const copy of added) {
        const original = sourceByNewId.get(copy.id);
        copy.parentId = original?.parentId && idMap.has(original.parentId) ? idMap.get(original.parentId)! : parentId;
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

  pasteAfter(parentId: string | null, branch: boolean): string | null {
    const built = this.buildPasteEntries(parentId);
    if (!built) return null;
    this.entries.push(...built.added);
    this.targetLeafId = built.lastParent;
    this.highlightEntryIds = built.added.map((e) => e.id);
    this.highlightUntil = Date.now() + 3000;
    this.dirty = true;
    this.message = `Pasted ${built.added.length} entr${built.added.length === 1 ? "y" : "ies"}${branch ? " as new branch" : ""}`;
    return built.lastParent;
  }

  replaceRangeWithClipboard(selectedId: string, foldedIds: Set<string> = new Set()): string | null {
    if (!this.markId) return this.pasteAfter(selectedId, false);
    const range = this.selectedEntries(selectedId, foldedIds);
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
    this.targetLeafId = built.lastParent;
    this.highlightEntryIds = built.added.map((e) => e.id);
    this.highlightUntil = Date.now() + 3000;
    this.cleanupLabels();
    this.dirty = true;
    this.message = `Replaced ${range.length} entr${range.length === 1 ? "y" : "ies"} with ${built.added.length}`;
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

  async compactToClipboard(selectedId: string, ctx: Ctx, foldedIds: Set<string> = new Set()): Promise<void> {
    const entries = this.selectedEntries(selectedId, foldedIds);
    if (!entries.length) {
      this.message = "No range to compact";
      return;
    }
    if (!ctx.model) {
      this.message = "No active model for AI compaction";
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
      "Summarize this selected conversation range for future context. Preserve decisions, constraints, user preferences, important facts, and unresolved tasks. Do not include raw transcript unless necessary.",
      undefined,
      "off"
    );
    generated = generated.trim();
    const summary = await ctx.ui.editor("Review AI compaction summary", generated);
    if (!summary?.trim()) {
      this.message = "Compaction cancelled";
      return;
    }
    this.clipboard = { kind: "compaction", summary: summary.trim(), sourceEntryIds: entries.map((e) => e.id), label: `AI compaction of ${entries.length}`, tokensBefore: estimateTokensForEntries(entries) };
    this.flashEntryIds = entries.map((e) => e.id);
    this.flashNonce += 1;
    this.viewSelectedId = selectedId;
    this.message = `Copied ${this.clipboard.label}; press p to replace the active range, or v to cancel range`;
  }
}

class TreeEditComponent {
  private draft: DraftSession;
  private ctx: Ctx;
  private theme: Theme;
  private done: (result: ExitResult) => void;
  private tui: any;
  private selected = 0;
  private scroll = 0;
  private filterMode: FilterMode = "no-tools";
  private foldedIds = new Set<string>();
  private flashSeenNonce = 0;
  private flashOn = false;
  private flashTimer: ReturnType<typeof setInterval> | null = null;
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(draft: DraftSession, ctx: Ctx, tui: any, theme: Theme, done: (result: ExitResult) => void) {
    this.draft = draft;
    this.ctx = ctx;
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    const rows = this.visibleRows();
    const wantedId = this.draft.viewSelectedId ?? this.draft.targetLeafId;
    const idx = rows.findIndex((r) => r.entry.id === wantedId);
    if (idx >= 0) this.selected = idx;
  }

  invalidate(): void {}

  private ensureFlashAnimation(): void {
    if (this.flashSeenNonce === this.draft.flashNonce || !this.draft.flashEntryIds.length) return;
    this.flashSeenNonce = this.draft.flashNonce;
    if (this.flashTimer) clearInterval(this.flashTimer);
    let ticks = 0;
    this.flashOn = true;
    this.flashTimer = setInterval(() => {
      ticks += 1;
      this.flashOn = !this.flashOn;
      this.tui?.requestRender?.();
      if (ticks >= 6) {
        if (this.flashTimer) clearInterval(this.flashTimer);
        this.flashTimer = null;
        this.flashOn = false;
        this.tui?.requestRender?.();
      }
    }, 120);
  }

  private ensureHighlightTimer(): void {
    if (!this.draft.highlightEntryIds.length || Date.now() >= this.draft.highlightUntil || this.highlightTimer) return;
    this.highlightTimer = setTimeout(() => {
      this.highlightTimer = null;
      this.tui?.requestRender?.();
    }, Math.max(0, this.draft.highlightUntil - Date.now()));
  }

  handleInput(data: string): void {
    const key = normalizeInputKey(data);
    const rows = this.visibleRows();
    const selectedEntry = rows[this.selected]?.entry;
    const selectedId = selectedEntry?.id;
    let changed = false;

    if (key === "escape" || key === "ctrl+c" || key === "q") {
      this.done({ action: "quit" });
      return;
    }
    if (key === "u") {
      this.draft.undo();
      this.clampSelection();
      changed = true;
    } else if (key === "U") {
      this.draft.redo();
      this.clampSelection();
      changed = true;
    }
    else if (key === "up" || key === "k") { this.move(-1); changed = true; }
    else if (key === "down" || key === "j") { this.move(1); changed = true; }
    else if (key === "pageup") { this.move(-10); changed = true; }
    else if (key === "pagedown") { this.move(10); changed = true; }
    else if (selectedId && key === "ctrl+left") {
      const row = rows[this.selected];
      if (row?.foldable) {
        this.foldedIds.add(selectedId);
        this.clampSelection();
        changed = true;
      }
    }
    else if (selectedId && key === "ctrl+right") {
      if (this.foldedIds.delete(selectedId)) {
        this.clampSelection();
        changed = true;
      }
    }
    else if (key === "f") {
      this.filterMode = this.filterMode === "default" ? "no-tools" : this.filterMode === "no-tools" ? "user-only" : this.filterMode === "user-only" ? "labeled-only" : this.filterMode === "labeled-only" ? "all" : "default";
      this.draft.message = `Filter: ${this.filterMode}`;
      this.clampSelection();
      changed = true;
    }
    else if (selectedId && key === "v") {
      if (this.draft.markId) {
        this.draft.markId = null;
        this.draft.message = "Range cancelled";
      } else {
        this.draft.markId = selectedId;
        this.draft.message = `Range started at ${selectedId}; move cursor, then y to copy, c to cut, or C to compact`;
      }
      changed = true;
    } else if (selectedId && key === "y") {
      this.draft.checkpoint();
      this.draft.copyRange(selectedId, this.foldedIds);
      changed = true;
    } else if (selectedId && key === "c") {
      this.draft.checkpoint();
      this.draft.cutRange(selectedId, this.foldedIds);
      this.clampSelection();
      changed = true;
    } else if (selectedId && key === "p") {
      this.draft.checkpoint();
      if (this.draft.markId) this.draft.replaceRangeWithClipboard(selectedId, this.foldedIds);
      else this.draft.pasteAfter(selectedId, false);
      this.selectId(this.draft.targetLeafId);
      changed = true;
    } else if (selectedId && key === "P") {
      if (this.draft.markId) {
        this.draft.message = "P is disabled while a range is active; use p to replace the range or v to cancel";
      } else {
        this.draft.checkpoint();
        this.draft.pasteAfter(selectedId, true);
        this.selectId(this.draft.targetLeafId);
      }
      changed = true;
    } else if (selectedId && key === "d") {
      this.draft.checkpoint();
      this.draft.deleteRangeOrEntry(selectedId, this.foldedIds);
      this.clampSelection();
      changed = true;
    } else if (selectedId && key === "D") {
      this.draft.checkpoint();
      this.draft.deleteSubtree(selectedId);
      this.clampSelection();
      changed = true;
    } else if (selectedId && key === "r") {
      this.draft.checkpoint();
      this.draft.redoFrom(selectedId);
      this.selectId(selectedId);
      changed = true;
    } else if (selectedId && (key === "b" || key === "return")) {
      this.draft.checkpoint();
      this.draft.targetLeafId = selectedId;
      this.draft.dirty = true;
      this.draft.message = `Current location set to ${selectedId}`;
      changed = true;
    } else if (selectedId && key === "e") {
      this.draft.viewSelectedId = selectedId;
      this.done({ action: "edit", id: selectedId });
      return;
    } else if (selectedId && key === "L") {
      this.draft.viewSelectedId = selectedId;
      this.done({ action: "label", id: selectedId });
      return;
    } else if (selectedId && key === "C") {
      this.draft.viewSelectedId = selectedId;
      (this.draft as any).__lastFoldedIds = new Set(this.foldedIds);
      this.done({ action: "compact", id: selectedId });
      return;
    }

    if (changed) this.tui?.requestRender?.();
  }

  private visibleRows(): TreeRow[] {
    return visibleRows(this.draft.entries, this.filterMode, this.foldedIds);
  }

  private clampSelection(): void {
    const count = this.visibleRows().length;
    this.selected = Math.max(0, Math.min(Math.max(0, count - 1), this.selected));
    const pageSize = this.pageSize();
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + pageSize) this.scroll = Math.max(0, this.selected - pageSize + 1);
    this.draft.viewSelectedId = this.visibleRows()[this.selected]?.entry.id ?? null;
  }

  private selectId(id: string | null): void {
    if (!id) return;
    const rows = this.visibleRows();
    let idx = rows.findIndex((r) => r.entry.id === id);
    if (idx < 0) {
      const byId = entryMap(this.draft.entries);
      let cur = id ? byId.get(id) : undefined;
      while (cur && idx < 0) {
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        if (cur) idx = rows.findIndex((r) => r.entry.id === cur!.id);
      }
    }
    if (idx >= 0) this.selected = idx;
    this.clampSelection();
    this.draft.viewSelectedId = id;
  }

  private move(delta: number): void {
    this.selected += delta;
    this.clampSelection();
  }

  private pageSize(): number { return 32; }

  private treePrefix(row: TreeRow): string {
    const displayIndent = row.depth;
    if (displayIndent <= 0) return row.folded ? "⊞ " : row.foldable ? "⊟ " : "";
    const connector = row.showConnector && !row.isVirtualRootChild;
    const connectorPosition = connector ? displayIndent - 1 : -1;
    const parts: string[] = [];
    for (let level = 0; level < displayIndent; level++) {
      if (connector && level === connectorPosition) {
        const fold = row.folded ? "⊞" : row.foldable ? "⊟" : "─";
        parts.push(`${row.isLast ? "└" : "├"}${fold} `);
      } else {
        parts.push(row.gutters[level] ? "│  " : "   ");
      }
    }
    return parts.join("");
  }

  private displayText(entry: Entry, selected: boolean): string {
    const th = this.theme;
    const normalize = (s: string) => compactLine(s);
    let result = "";
    if (entry.type === "message") {
      const msg = entry.message;
      if (msg?.role === "user") result = th.fg("accent", "user: ") + normalize(textFromContent(msg.content));
      else if (msg?.role === "assistant") {
        const text = normalize(textFromContent(msg.content));
        result = th.fg("success", "assistant: ") + (text || th.fg("muted", msg.errorMessage || (msg.stopReason === "aborted" ? "(aborted)" : "(no content)")));
      } else result = th.fg("dim", `[${msg?.role || "message"}] ${normalize(entryText(entry))}`);
    } else if (entry.type === "branch_summary") result = th.fg("warning", "[branch summary]: ") + normalize(entry.summary || "");
    else if (entry.type === "compaction") result = th.fg("borderAccent", `[compaction: ${Math.round((entry.tokensBefore || 0) / 1000)}k tokens]`);
    else if (entry.type === "custom_message") result = th.fg("customMessageLabel", `[${entry.customType}]: `) + normalize(textFromContent(entry.content));
    else result = th.fg("dim", `[${entryKind(entry)}] ${normalize(entryText(entry))}`);
    return selected ? th.bold(result) : result;
  }

  render(width: number): string[] {
    this.ensureFlashAnimation();
    this.ensureHighlightTimer();
    const bodyWidth = Math.max(80, width - 2);
    const th = this.theme;
    const rows = this.visibleRows();
    const allCount = this.draft.entries.length;
    const labels = buildLabels(this.draft.entries);
    const selectedId = rows[this.selected]?.entry.id;
    const rangeIds = new Set(this.draft.markId && selectedId ? this.draft.range(this.draft.markId, selectedId).map((e) => e.id) : []);
    const clipboardIds = new Set<string>((this.draft.clipboard as any)?.sourceEntryIds ?? []);
    const flashIds = new Set<string>(this.draft.flashEntryIds);
    const highlightIds = Date.now() < this.draft.highlightUntil ? new Set<string>(this.draft.highlightEntryIds) : new Set<string>();
    const lines: string[] = [];
    lines.push(`${this.draft.dirty ? th.fg("warning", "modified") : th.fg("success", "clean")} ${th.fg("dim", "|")} filter: ${th.fg("accent", this.filterMode)} ${th.fg("dim", "|")} clipboard: ${this.draft.clipboard ? th.fg("accent", this.draft.clipboard.label) : th.fg("dim", "empty")} ${th.fg("dim", "|")} range: ${this.draft.markId ? th.fg("accent", this.draft.markId) : th.fg("dim", "none")} ${th.fg("dim", "|")} current location: ${this.draft.targetLeafId ?? "root"}`);
    lines.push(...wrapHelp(HELP_ITEMS, bodyWidth - 4, th));
    if (this.draft.message) lines.push(th.fg(this.draft.message.toLowerCase().includes("cannot") || this.draft.message.toLowerCase().includes("error") ? "error" : "accent", this.draft.message));
    lines.push("");
    const visible = rows.slice(this.scroll, this.scroll + this.pageSize());
    for (let i = 0; i < visible.length; i++) {
      const real = this.scroll + i;
      const row = visible[i];
      const entry = row.entry;
      const selected = real === this.selected;
      const inRange = rangeIds.has(entry.id);
      const isMark = this.draft.markId === entry.id;
      const isTarget = this.draft.targetLeafId === entry.id;
      const inClipboard = clipboardIds.has(entry.id);
      const isFlashing = this.flashOn && flashIds.has(entry.id);
      const isHighlighted = highlightIds.has(entry.id);
      const cursor = selected ? th.fg("accent", "› ") : "  ";
      const pathMarker = isFlashing ? th.fg("warning", "◆ ") : inClipboard && isTarget ? th.fg("warning", "◆ ") : inClipboard ? th.fg("success", "◆ ") : isTarget ? th.fg("accent", "◆ ") : "  ";
      const editMarkers = isMark || inRange ? `${isMark ? th.fg("warning", "M") : " "}${inRange ? th.fg("accent", "R") : " "} ` : "";
      const label = labels.get(entry.id);
      const labelText = label ? th.fg("warning", `[${label}] `) : "";
      const prefix = th.fg("dim", this.treePrefix(row));
      let line = `${cursor}${editMarkers}${prefix}${pathMarker}${labelText}${this.displayText(entry, selected)}`;
      if (selected || isHighlighted) line = th.bg("selectedBg", line);
      lines.push(truncateToWidth(line, bodyWidth));
    }
    if (!rows.length) lines.push(th.fg("dim", "  No entries in current filter (press f)"));
    lines.push("");
    lines.push(th.fg("dim", `(${rows.length ? this.selected + 1 : 0}/${rows.length}) [${this.filterMode}] ${allCount !== rows.length ? `${allCount - rows.length} hidden · ` : ""}q/Esc prompts to save or discard`));
    return box(lines, bodyWidth, " tree-edit ", th);
  }
}

async function saveDraft(sessionFile: string, draft: DraftSession, ctx: Ctx): Promise<void> {
  draft.cleanupLabels();
  const errors = validateDraft(draft.header, draft.entries);
  if (errors.length) throw new Error(`Draft validation failed:\n${errors.slice(0, 10).join("\n")}`);
  const backup = `${sessionFile}.bak-${timestampForFile()}`;
  copyFileSync(sessionFile, backup);
  const content = [draft.header, ...draft.entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(sessionFile, content, "utf8");
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

      const parsed = parseSessionFile(sessionFile);
      const draft = new DraftSession(parsed.header, parsed.entries, ctx.sessionManager.getLeafId?.() ?? null);

      while (true) {
        const result = await ctx.ui.custom<ExitResult>((tui: any, theme: Theme, _kb: any, done: (result: ExitResult) => void) => new TreeEditComponent(draft, ctx, tui, theme, done), {
          overlay: true,
          overlayOptions: { anchor: "center", width: "99%", maxHeight: "98%", minWidth: 90, margin: 0 },
        });

        if (result?.action === "edit") {
          draft.checkpoint();
          await draft.editEntry(result.id, ctx);
          continue;
        }
        if (result?.action === "compact") {
          draft.checkpoint();
          await draft.compactToClipboard(result.id, ctx, (draft as any).__lastFoldedIds ?? new Set());
          continue;
        }
        if (result?.action === "label") {
          draft.checkpoint();
          await draft.editLabel(result.id, ctx);
          continue;
        }

        const choices = draft.dirty ? ["Quit without saving", "Save and quit", "Cancel"] : ["Quit", "Cancel"];
        const choice = await ctx.ui.select(draft.dirty ? "Save tree-edit changes?" : "Quit tree-edit?", choices);
        if (choice === "Cancel" || !choice) continue;
        if (choice === "Quit" || choice === "Quit without saving") return;
        if (choice === "Save and quit") {
          await saveDraft(sessionFile, draft, ctx);
          return;
        }
      }
    },
  });
}
