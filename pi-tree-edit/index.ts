import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { generateSummary } from "@earendil-works/pi-coding-agent";
import { boxLines, hasTextContent, PipCustomComponent, pipSettings, registerSettingsSection, setTextContent, setting, stripAnsi, textFromContent as commonTextFromContent } from "pip-common";

type ExtensionAPI = any;
type Theme = any;
type Ctx = any;

type Header = { type: "session"; [key: string]: any };
type Entry = { type: string; id: string; parentId: string | null; timestamp: string; [key: string]: any };
type FileEntry = Header | Entry;
type SnapshotToolResults = "off" | "truncated" | "full";
type SummarySnapshotPolicy = { summarySnapshots: boolean; snapshotToolResults: SnapshotToolResults; toolResultTruncation: number };
type Clipboard =
  | { kind: "entries"; entries: Entry[]; label: string; structure?: "linear" | "preserve" }
  | { kind: "summary"; summary: string; sourceEntryIds: string[]; sourceEntries?: Entry[]; label: string; snapshotPolicy: SummarySnapshotPolicy };

type ExitResult = { action: "quit" } | { action: "edit"; id: string } | { action: "summarize"; id: string } | { action: "label"; id: string };
type FilterMode = "default" | "show-tools" | "user-only" | "labeled-only" | "all";
type TreeGutter = { position: number; show: boolean };
type SummarySourceVirtualRow = { kind: "summary-source"; summaryEntryId: string; sourceEntryId: string; fromSnapshot: boolean; missing?: boolean };
type TreeRow = { entry: Entry; depth: number; isLast: boolean; gutters: TreeGutter[]; showConnector: boolean; isVirtualRootChild: boolean; foldable: boolean; folded: boolean; multipleRoots: boolean; activePath: boolean; virtual?: SummarySourceVirtualRow };
type DraftSnapshot = { entries: Entry[]; targetLeafId: string | null; clipboard: Clipboard | null; markId: string | null; dirty: boolean };

const EXT = "pi-tree-edit";
const SUMMARY_CUSTOM_TYPE = "pi-tree-edit.summary";
const TREE_EDIT_SETTINGS_ID = "tree-edit";
const HELP_ITEMS = [
  "j/k move", "Ctrl+←/→ fold",
  "/ search", "f filter",
  "Enter/b set current location",
  "v start/cancel range",
  "i include branches",
  "y copy",
  "c cut",
  "C add compaction entry",
  "S summarize",
  "o open summary",
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
  return commonTextFromContent(content, "\n");
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
  if (mode === "show-tools") return !isSettingsEntry;
  return !isSettingsEntry && !(entry.type === "message" && entry.message?.role === "toolResult");
}

function compactLine(value: string): string {
  return stripAnsi(value).replace(/\s+/g, " ").trim();
}

function getSummarySettings(): SummarySnapshotPolicy {
  return {
    summarySnapshots: Boolean(pipSettings.get(`${TREE_EDIT_SETTINGS_ID}.summarySnapshots`)),
    snapshotToolResults: pipSettings.get<SnapshotToolResults>(`${TREE_EDIT_SETTINGS_ID}.snapshotToolResults`),
    toolResultTruncation: pipSettings.get<number>(`${TREE_EDIT_SETTINGS_ID}.toolResultTruncation`),
  };
}

function isSummaryEntry(entry: Entry): boolean {
  return entry.type === "custom_message" && entry.customType === SUMMARY_CUSTOM_TYPE && entry.details?.kind === "summary";
}

function isToolLikeEntry(entry: Entry): boolean {
  const role = entry.type === "message" ? entry.message?.role : undefined;
  return role === "toolResult" || role === "bashExecution";
}

function isNormalMessageEntry(entry: Entry | undefined): entry is Entry {
  const role = entry?.type === "message" ? entry.message?.role : undefined;
  return role === "user" || role === "assistant";
}

function truncateStrings(value: any, limit: number): any {
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}\n...[truncated by ${EXT}: ${value.length - limit} chars omitted]` : value;
  if (Array.isArray(value)) return value.map((item) => truncateStrings(item, limit));
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [key, child] of Object.entries(value)) out[key] = truncateStrings(child, limit);
    return out;
  }
  return value;
}

function snapshotEntries(entries: Entry[], policy: SummarySnapshotPolicy): Entry[] | undefined {
  if (!policy.summarySnapshots) return undefined;
  const snapshots: Entry[] = [];
  for (const entry of entries) {
    if (isToolLikeEntry(entry) && policy.snapshotToolResults === "off") continue;
    let snapshot = clone(entry);
    if (isToolLikeEntry(entry) && policy.snapshotToolResults === "truncated") {
      snapshot = truncateStrings(snapshot, Math.max(1, policy.toolResultTruncation));
      snapshot.details = { ...(snapshot.details ?? {}), snapshotTruncatedBy: EXT };
    }
    snapshots.push(snapshot);
  }
  return snapshots;
}

function summaryDetails(entry: Entry): any | undefined {
  return isSummaryEntry(entry) ? entry.details : undefined;
}

function summarySourceIds(entry: Entry): string[] {
  const ids = summaryDetails(entry)?.sourceEntryIds;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
}

function createSummaryEntry(clipboard: Extract<Clipboard, { kind: "summary" }>, id: string, parentId: string | null, timestamp: string): Entry {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp,
    customType: SUMMARY_CUSTOM_TYPE,
    content: [{ type: "text", text: `Summary of selected tree range:\n\n${clipboard.summary}` }],
    display: true,
    details: {
      from: EXT,
      kind: "summary",
      sourceEntryIds: clipboard.sourceEntryIds,
      sourceEntries: clipboard.sourceEntries,
      sourceLabel: clipboard.label,
      snapshotPolicy: clipboard.snapshotPolicy,
    },
  };
}

function missingSourceEntry(summaryEntry: Entry, sourceEntryId: string): Entry {
  return { type: "custom", id: `missing:${summaryEntry.id}:${sourceEntryId}`, parentId: summaryEntry.id, timestamp: summaryEntry.timestamp, customType: "missing-summary-source", data: { sourceEntryId } };
}

function resolveSummarySourceRows(summaryEntry: Entry, allEntries: Entry[]): Array<{ entry: Entry; fromSnapshot: boolean; missing: boolean; sourceEntryId: string }> {
  const byId = entryMap(allEntries);
  const snapshots = new Map<string, Entry>();
  const rawSnapshots = summaryDetails(summaryEntry)?.sourceEntries;
  if (Array.isArray(rawSnapshots)) for (const entry of rawSnapshots) if (entry?.id) snapshots.set(entry.id, entry);
  return summarySourceIds(summaryEntry).map((sourceEntryId) => {
    const live = byId.get(sourceEntryId);
    if (live) return { entry: live, fromSnapshot: false, missing: false, sourceEntryId };
    const snapshot = snapshots.get(sourceEntryId);
    if (snapshot) return { entry: clone(snapshot), fromSnapshot: true, missing: false, sourceEntryId };
    return { entry: missingSourceEntry(summaryEntry, sourceEntryId), fromSnapshot: false, missing: true, sourceEntryId };
  });
}

function rowKey(row: TreeRow): string {
  return row.virtual ? `virtual:${row.virtual.summaryEntryId}:${row.virtual.sourceEntryId}` : row.entry.id;
}

function estimateTokensForEntries(entries: Entry[]): number {
  const chars = entries.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

function estimateContextTokensForEntry(entry: Entry): number {
  if (entry.type === "message") return Math.max(1, Math.ceil((entryText(entry).length + 12) / 4));
  if (entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary") return Math.max(1, Math.ceil((entryText(entry).length + 12) / 4));
  return 0;
}

function contextUsageFromMessage(message: any): number {
  const usage = message?.usage;
  if (!usage) return 0;
  return Math.max(0, Math.ceil(usage.totalTokens || (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0)));
}

function contextPercentByEntry(entries: Entry[], contextWindow: number): Map<string, number> {
  const out = new Map<string, number>();
  if (!contextWindow || contextWindow <= 0) return out;
  const byId = entryMap(entries);
  const pathMemo = new Map<string, Entry[]>();
  const pathTo = (entry: Entry, seen = new Set<string>()): Entry[] => {
    if (pathMemo.has(entry.id)) return pathMemo.get(entry.id)!;
    if (seen.has(entry.id)) return [entry];
    seen.add(entry.id);
    const parent = entry.parentId ? byId.get(entry.parentId) : undefined;
    const path = parent ? [...pathTo(parent, seen), entry] : [entry];
    pathMemo.set(entry.id, path);
    return path;
  };
  const tokensForPath = (path: Entry[]): number => {
    let baseline = 0;
    let start = 0;
    for (let i = path.length - 1; i >= 0; i--) {
      const entry = path[i];
      if (entry.type !== "message") continue;
      if (entry.message?.role !== "assistant" || entry.message?.stopReason === "aborted" || entry.message?.stopReason === "error") continue;
      const usageTokens = contextUsageFromMessage(entry.message);
      if (usageTokens > 0) {
        baseline = usageTokens;
        start = i + 1;
        break;
      }
    }
    let trailing = 0;
    for (let i = start; i < path.length; i++) trailing += estimateContextTokensForEntry(path[i]);
    return baseline + trailing;
  };
  for (const entry of entries) out.set(entry.id, Math.min(999, Math.round((tokensForPath(pathTo(entry)) / contextWindow) * 100)));
  return out;
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

function activePathIds(entries: Entry[], leafId: string | null): Set<string> {
  const byId = entryMap(entries);
  const active = new Set<string>();
  let cur = leafId ? byId.get(leafId) : undefined;
  while (cur && !active.has(cur.id)) {
    active.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return active;
}

function flattenEntries(entries: Entry[], activeIds: Set<string> = new Set()): Array<{ entry: Entry }> {
  const children = childrenMap(entries);
  const out: Array<{ entry: Entry }> = [];
  const seen = new Set<string>();
  const ordered = (items: Entry[]) => [...items].sort((a, b) => Number(activeIds.has(b.id)) - Number(activeIds.has(a.id)) || Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const visit = (entry: Entry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push({ entry });
    for (const child of ordered(children.get(entry.id) ?? [])) visit(child);
  };
  for (const root of ordered(children.get(null) ?? [])) visit(root);
  for (const entry of entries) if (!seen.has(entry.id)) visit(entry);
  return out;
}

function visibleRows(entries: Entry[], mode: FilterMode, foldedIds: Set<string> = new Set(), searchQuery = "", activeLeafId: string | null = null): TreeRow[] {
  const activeIds = activePathIds(entries, activeLeafId);
  const flat = flattenEntries(entries, activeIds);
  const byId = entryMap(entries);
  const labels = buildLabels(entries);

  const findVisibleAncestor = (entry: Entry, visibleIds: Set<string>): string | null => {
    let currentId = entry.parentId;
    while (currentId !== null) {
      if (visibleIds.has(currentId)) return currentId;
      currentId = byId.get(currentId)?.parentId ?? null;
    }
    return null;
  };

  const buildVisibleMaps = (rows: Array<{ entry: Entry }>) => {
    const visibleIds = new Set(rows.map((row) => row.entry.id));
    const parentMap = new Map<string, string | null>();
    const children = new Map<string | null, string[]>();
    children.set(null, []);
    for (const row of rows) {
      const parentId = findVisibleAncestor(row.entry, visibleIds);
      parentMap.set(row.entry.id, parentId);
      const siblings = children.get(parentId) ?? [];
      siblings.push(row.entry.id);
      children.set(parentId, siblings);
    }
    return { parentMap, children };
  };

  // Match Pi's TreeList.applyFilter(): filter flat nodes first, then hide folded descendants,
  // then recalculate all visible indentation/connectors/gutters from the resulting tree.
  const searchTokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const matchesSearch = (entry: Entry): boolean => {
    if (!searchTokens.length) return true;
    const text = `${entryKind(entry)} ${entryText(entry)} ${labels.get(entry.id) ?? ""}`.toLowerCase();
    return searchTokens.every((token) => text.includes(token));
  };
  const preFoldRows = flat.filter((row) => isVisibleEntry(row.entry, mode, labels) && matchesSearch(row.entry));
  const preFoldMaps = buildVisibleMaps(preFoldRows);
  const hiddenByFold = new Set<string>();
  if (foldedIds.size > 0) {
    for (const row of flat) {
      const { id, parentId } = row.entry;
      if (parentId !== null && (foldedIds.has(parentId) || hiddenByFold.has(parentId))) hiddenByFold.add(id);
    }
  }

  const filteredRows = preFoldRows.filter((row) => !hiddenByFold.has(row.entry.id));
  const visibleMaps = buildVisibleMaps(filteredRows);
  const visibleById = new Map(filteredRows.map((row) => [row.entry.id, row.entry]));
  const visibleRootIds = visibleMaps.children.get(null) ?? [];
  const multipleRoots = visibleRootIds.length > 1;
  const out: TreeRow[] = [];
  const stack: Array<[string, number, boolean, boolean, boolean, TreeGutter[], boolean]> = [];

  for (let i = visibleRootIds.length - 1; i >= 0; i--) {
    stack.push([
      visibleRootIds[i],
      multipleRoots ? 1 : 0,
      multipleRoots,
      multipleRoots,
      i === visibleRootIds.length - 1,
      [],
      multipleRoots,
    ]);
  }

  while (stack.length > 0) {
    const [id, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;
    const entry = visibleById.get(id);
    if (!entry) continue;

    const children = visibleMaps.children.get(id) ?? [];
    const preFoldChildren = preFoldMaps.children.get(id) ?? [];
    const parentId = preFoldMaps.parentMap.get(id) ?? null;
    const siblings = preFoldMaps.children.get(parentId) ?? [];
    const foldable = preFoldChildren.length > 0 && (parentId === null || siblings.length > 1);
    const folded = foldedIds.has(id) && foldable;
    out.push({ entry, depth: indent, isLast, gutters, showConnector, isVirtualRootChild, foldable, folded, multipleRoots, activePath: activeIds.has(entry.id) });

    const multipleChildren = children.length > 1;
    let childIndent: number;
    if (multipleChildren) childIndent = indent + 1;
    else if (justBranched && indent > 0) childIndent = indent + 1;
    else childIndent = indent;

    const connectorDisplayed = showConnector && !isVirtualRootChild;
    const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
    const connectorPosition = Math.max(0, currentDisplayIndent - 1);
    const childGutters = connectorDisplayed ? [...gutters, { position: connectorPosition, show: !isLast }] : gutters;

    for (let i = children.length - 1; i >= 0; i--) {
      stack.push([children[i], childIndent, multipleChildren, multipleChildren, i === children.length - 1, childGutters, false]);
    }
  }

  return out;
}

function expandSummaryRows(rows: TreeRow[], entries: Entry[], expandedSummaryIds: Set<string>): TreeRow[] {
  const out: TreeRow[] = [];
  for (const row of rows) {
    out.push(row);
    if (!isSummaryEntry(row.entry) || !expandedSummaryIds.has(row.entry.id)) continue;
    const sources = resolveSummarySourceRows(row.entry, entries);
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      out.push({
        entry: source.entry,
        depth: row.depth + 1,
        isLast: i === sources.length - 1,
        gutters: [...row.gutters],
        showConnector: true,
        isVirtualRootChild: false,
        foldable: false,
        folded: false,
        multipleRoots: row.multipleRoots,
        activePath: false,
        virtual: { kind: "summary-source", summaryEntryId: row.entry.id, sourceEntryId: source.sourceEntryId, fromSnapshot: source.fromSnapshot, missing: source.missing },
      });
    }
  }
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

function pathToRoot(entries: Entry[], id: string): Entry[] {
  const byId = entryMap(entries);
  const path: Entry[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

function pathBetween(entries: Entry[], a: string, b: string): Entry[] | null {
  const pa = pathToRoot(entries, a);
  const pb = pathToRoot(entries, b);
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
  return boxLines(lines, Math.max(40, width), theme, { title });
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
  flashKind: "copy" | "cut" | "paste" | "summary" | null = null;
  highlightEntryIds: string[] = [];
  highlightKind: "copy" | "paste" | "summary" | null = null;
  lastOperation = "";
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

  redoFrom(id: string): void {
    const removed = descendantsOf(this.entries, id);
    this.entries = this.entries.filter((entry) => !removed.has(entry.id) && !(entry.type === "label" && removed.has(entry.targetId)));
    this.targetLeafId = id;
    this.cleanupLabels();
    this.dirty = true;
    this.highlightEntryIds = [id];
    this.highlightKind = "paste";
    this.lastOperation = `rewound to ${id}; removed ${removed.size}`;
    this.message = `Rewound to ${id}: removed ${removed.size} later entr${removed.size === 1 ? "y" : "ies"}`;
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

  addCompactionAfter(selectedId: string): string | null {
    const selected = this.entries.find((entry) => entry.id === selectedId);
    if (!isNormalMessageEntry(selected)) {
      this.message = "Select a user/assistant message to add compaction";
      return null;
    }

    const existing = this.ids();
    const id = newId(existing);
    const continuationChild = this.childOnContinuation(selectedId);
    const compactedPath = pathToRoot(this.entries, selectedId);
    const entry: Entry = {
      type: "compaction",
      id,
      parentId: selectedId,
      timestamp: new Date().toISOString(),
      summary: "",
      firstKeptEntryId: continuationChild?.id ?? id,
      tokensBefore: compactedPath.reduce((sum, entry) => sum + estimateContextTokensForEntry(entry), 0),
      details: { from: EXT, kind: "manual", compactedThroughEntryId: selectedId },
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
    this.lastOperation = "added compaction entry";
    this.message = "Added compaction entry; press e to edit summary";
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
    const snapshotPolicy = getSummarySettings();
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
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(draft: DraftSession, ctx: Ctx, tui: any, theme: Theme, done: (result?: ExitResult) => void) {
    super(tui, theme, done, { closeKeys: [] });
    this.draft = draft;
    this.ctx = ctx;
    const rows = this.visibleRows();
    const wantedId = this.draft.viewSelectedId ?? this.draft.targetLeafId;
    const idx = rows.findIndex((r) => r.entry.id === wantedId);
    if (idx >= 0) this.selected = idx;
    this.clampSelection();
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

  private ensureHighlightTimer(): void {}

  dispose(): void {
    if (this.flashTimer) {
      clearInterval(this.flashTimer);
      this.flashTimer = null;
    }
    if (this.highlightTimer) {
      clearTimeout(this.highlightTimer);
      this.highlightTimer = null;
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
      else if (key === "backspace" || key === "delete" || key === "ctrl+h") { this.searchQuery = this.searchQuery.slice(0, -1); this.clampSelection(); }
      else if (key === "space") { this.searchQuery += " "; this.clampSelection(); }
      else if (key.length === 1 && key.charCodeAt(0) >= 32) { this.searchQuery += key; this.clampSelection(); }
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
    if (key === "u") { this.draft.undo(); this.clampSelection(); changed = true; }
    else if (key === "U") { this.draft.redo(); this.clampSelection(); changed = true; }
    else if (key === "up" || key === "k") { this.move(-1); changed = true; }
    else if (key === "down" || key === "j") { this.move(1); changed = true; }
    else if (key === "pageup") { this.move(-10); changed = true; }
    else if (key === "pagedown") { this.move(10); changed = true; }
    else if (selectedId && key === "ctrl+left") {
      if (!isVirtual && selectedRow?.foldable) { this.foldedIds.add(selectedId); this.clampSelection(); changed = true; }
    }
    else if (selectedId && key === "ctrl+right") {
      if (!isVirtual && this.foldedIds.delete(selectedId)) { this.clampSelection(); changed = true; }
    }
    else if (key === "/") { this.searchMode = true; this.draft.message = "Search: type to filter, Enter to keep, Esc to stop editing search"; changed = true; }
    else if (key === "i") { this.includeSubbranches = !this.includeSubbranches; this.draft.message = this.includeSubbranches ? "Range operations include subbranches" : "Range operations use main path only"; changed = true; }
    else if (key === "f") { this.filterMode = this.filterMode === "default" ? "show-tools" : this.filterMode === "show-tools" ? "user-only" : this.filterMode === "user-only" ? "labeled-only" : this.filterMode === "labeled-only" ? "all" : "default"; this.draft.message = `Filter: ${this.filterLabel(this.filterMode)}`; this.clampSelection(); changed = true; }
    else if (selectedRow && key === "o") {
      const summaryId = selectedRow.virtual?.summaryEntryId ?? (isSummaryEntry(selectedRow.entry) ? selectedRow.entry.id : undefined);
      if (summaryId) {
        if (this.expandedSummaryIds.has(summaryId)) this.expandedSummaryIds.delete(summaryId);
        else this.expandedSummaryIds.add(summaryId);
        this.draft.message = this.expandedSummaryIds.has(summaryId) ? "Summary opened" : "Summary closed";
        this.clampSelection();
      } else this.draft.message = "Selected row is not a summary";
      changed = true;
    }
    else if (selectedRowKey && key === "v") {
      if (this.draft.markId) { this.draft.markId = null; this.draft.message = "Range cancelled"; }
      else { this.draft.markId = selectedRowKey; this.draft.message = `Range started at ${selectedId}; move cursor, then y to copy, c to cut, or S to summarize`; }
      changed = true;
    } else if (selectedRowKey && selectedId && key === "y") {
      this.draft.checkpoint();
      this.draft.copyRange(selectedId, this.foldedIds, this.operationRangeEntries(rows, selectedRowKey, false), this.includeSubbranches ? "preserve" : "linear");
      changed = true;
    } else if (selectedId && key === "c") {
      if (isVirtual) changed = virtualReadOnly();
      else { this.draft.checkpoint(); this.draft.cutRange(selectedId, this.foldedIds, this.operationRangeEntries(rows, selectedRowKey, false), this.includeSubbranches ? "preserve" : "linear"); this.clampSelection(); changed = true; }
    } else if (selectedId && key === "p") {
      if (isVirtual) { this.draft.message = "Select a real tree row to paste"; changed = true; }
      else { this.draft.checkpoint(); const pastedId = this.draft.markId ? this.draft.replaceRangeWithClipboard(selectedId, this.foldedIds, this.operationRangeEntries(rows, selectedRowKey, false)) : this.draft.pasteAfter(selectedId, false); this.selectId(pastedId); changed = true; }
    } else if (selectedId && key === "P") {
      if (isVirtual) this.draft.message = "Select a real tree row to paste";
      else if (this.draft.markId) this.draft.message = "P is disabled while a range is active; use p to replace the range or v to cancel";
      else { this.draft.checkpoint(); const pastedId = this.draft.pasteAfter(selectedId, true); this.selectId(pastedId); }
      changed = true;
    } else if (selectedId && key === "C") {
      if (isVirtual) this.draft.message = "Select a real tree row to add compaction";
      else { this.draft.checkpoint(); const compactionId = this.draft.addCompactionAfter(selectedId); this.selectId(compactionId); }
      changed = true;
    } else if (selectedId && key === "d") {
      if (isVirtual) changed = virtualReadOnly();
      else { this.draft.checkpoint(); this.draft.deleteRangeOrEntry(selectedId, this.foldedIds, this.operationRangeEntries(rows, selectedRowKey, false)); this.clampSelection(); changed = true; }
    } else if (selectedId && key === "D") {
      if (isVirtual) changed = virtualReadOnly();
      else { this.draft.checkpoint(); this.draft.deleteSubtree(selectedId); this.clampSelection(); changed = true; }
    } else if (selectedId && key === "r") {
      if (isVirtual) changed = virtualReadOnly();
      else { this.draft.checkpoint(); this.draft.redoFrom(selectedId); this.selectId(selectedId); changed = true; }
    } else if (selectedId && (key === "b" || key === "return")) {
      if (isVirtual) { this.draft.message = "Virtual summary rows cannot be the current location"; changed = true; }
      else { this.draft.checkpoint(); this.draft.targetLeafId = selectedId; this.draft.dirty = true; this.draft.message = `Current location set to ${selectedId}`; changed = true; }
    } else if (selectedId && key === "e") {
      if (isVirtual) { this.draft.message = "Virtual summary rows are read-only"; changed = true; }
      else { this.draft.viewSelectedId = selectedId; this.close({ action: "edit", id: selectedId }); return; }
    } else if (selectedId && key === "L") {
      if (isVirtual) { this.draft.message = "Virtual summary rows cannot be labeled"; changed = true; }
      else { this.draft.viewSelectedId = selectedId; this.close({ action: "label", id: selectedId }); return; }
    } else if (selectedId && key === "S") {
      if (isVirtual) { this.draft.message = "Select real rows to summarize"; changed = true; }
      else { this.draft.viewSelectedId = selectedId; (this.draft as any).__lastFoldedIds = new Set<string>(); (this.draft as any).__lastVisibleRangeEntries = this.operationRangeEntries(rows, selectedRowKey, true).map(clone); if (this.includeSubbranches) this.draft.message = "Summarization uses main path only; subbranches excluded"; this.close({ action: "summarize", id: selectedId }); return; }
    }

    if (changed) this.requestRender();
  }

  private visibleRows(): TreeRow[] {
    const base = visibleRows(this.draft.entries, this.filterMode, this.foldedIds, this.searchQuery, this.draft.targetLeafId);
    return expandSummaryRows(base, this.draft.entries, this.expandedSummaryIds);
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
    const byId = entryMap(this.draft.entries);
    const pathToRoot = (id: string): string[] => {
      const path: string[] = [];
      const seen = new Set<string>();
      let cur = byId.get(id);
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        path.unshift(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return path;
    };
    const markPath = pathToRoot(this.draft.markId);
    const selectedPath = pathToRoot(selectedId);
    let common = 0;
    while (common < markPath.length && common < selectedPath.length && markPath[common] === selectedPath[common]) common++;
    const mainIds = new Set([...markPath.slice(common - 1), ...selectedPath.slice(common - 1)]);
    const visibleIds = new Set(this.visibleRangeEntries(rows, selectedKey).map((entry) => entry.id));
    const out = rows.map((row) => row.entry).filter((entry) => visibleIds.has(entry.id) && mainIds.has(entry.id));
    return out.length ? out : this.visibleRangeEntries(rows, selectedKey);
  }

  private operationRangeEntries(rows = this.visibleRows(), selectedKey = rows[this.selected] ? rowKey(rows[this.selected]) : undefined, forceMainPath = false): Entry[] {
    const base = forceMainPath || !this.includeSubbranches ? this.mainPathRangeEntries(rows, selectedKey) : this.visibleRangeEntries(rows, selectedKey);
    if (forceMainPath || !this.includeSubbranches) return base;
    const ids = new Set(base.map((entry) => entry.id));
    for (const entry of base) {
      for (const childId of descendantsOf(this.draft.entries, entry.id)) ids.add(childId);
    }
    return this.draft.entries.filter((entry) => ids.has(entry.id));
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

  private pageSize(): number {
    const terminalHeight = this.tui?.terminal?.height ?? this.tui?.height ?? 40;
    // overlay margin is 1 top/bottom, box border is 2 rows, plus header/help/status rows.
    return Math.max(5, terminalHeight - 12);
  }

  private filterLabel(mode: FilterMode): string {
    return mode;
  }

  private treePrefix(row: TreeRow): string {
    const displayIndent = row.multipleRoots ? Math.max(0, row.depth - 1) : row.depth;
    const connector = row.showConnector && !row.isVirtualRootChild;
    const connectorPosition = connector ? displayIndent - 1 : -1;
    const totalChars = displayIndent * 3;
    const chars: string[] = [];

    for (let i = 0; i < totalChars; i++) {
      const level = Math.floor(i / 3);
      const posInLevel = i % 3;
      const gutter = row.gutters.find((g) => g.position === level);
      if (gutter) {
        chars.push(posInLevel === 0 ? (gutter.show ? "│" : " ") : " ");
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
    const labels = buildLabels(this.draft.entries);
    const selectedRow = rows[this.selected];
    const selectedId = selectedRow?.entry.id;
    const selectedKey = selectedRow ? rowKey(selectedRow) : undefined;
    const visibleRange = this.draft.markId && selectedKey ? this.visibleRangeEntries(rows, selectedKey) : [];
    const operationRange = this.draft.markId && selectedKey ? this.operationRangeEntries(rows, selectedKey, false) : [];
    const rangeIds = new Set(operationRange.map((e) => e.id));
    const hiddenFoldedCount = operationRange.length ? operationRange.filter((entry) => !visibleRange.some((visible) => visible.id === entry.id)).length : 0;
    const flashIds = new Set<string>(this.draft.flashEntryIds);
    const highlightIds = new Set<string>(this.draft.highlightEntryIds);
    const contextPercents = contextPercentByEntry(this.draft.entries, this.ctx.model?.contextWindow ?? 0);
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
    const visible = rows.slice(this.scroll, this.scroll + this.pageSize());
    for (let i = 0; i < visible.length; i++) {
      const real = this.scroll + i;
      const row = visible[i];
      const entry = row.entry;
      const selected = real === this.selected;
      const rowId = rowKey(row);
      const inRange = rangeIds.has(entry.id) || Boolean(this.draft.markId && visibleRange.some((visible) => visible.id === entry.id));
      const isMark = this.draft.markId === rowId;
      const isTarget = this.draft.targetLeafId === entry.id;
      const isFlashing = this.flashOn && flashIds.has(entry.id);
      const isHighlighted = highlightIds.has(entry.id);
      const cursor = selected ? th.fg("accent", "› ") : "  ";
      const label = labels.get(entry.id);
      const labelText = label ? th.fg("warning", `[${label}] `) : "";
      const prefix = th.fg(row.virtual ? "warning" : "dim", this.treePrefix(row));
      const pathMarker = row.virtual ? th.fg("warning", "• ") : isTarget ? th.fg("accent", "◆ ") : row.activePath ? th.fg("accent", "• ") : "";
      let line = `${cursor}${prefix}${pathMarker}${labelText}${this.displayText(row, selected)}`;
      if (selected) line = th.bg("selectedBg", line);
      else if (isFlashing && this.draft.flashKind === "cut") line = th.bg("toolErrorBg", line);
      else if (isFlashing) line = th.bg("toolPendingBg", line);
      else if ((inRange || isMark) && isHighlighted) line = th.bg("toolErrorBg", line);
      else if (isHighlighted && this.draft.highlightKind === "copy") line = th.bg("toolSuccessBg", line);
      else if (isHighlighted && this.draft.highlightKind === "summary") line = th.bg("toolSuccessBg", line);
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
  registerSettingsSection({
    id: TREE_EDIT_SETTINGS_ID,
    title: "Tree Edit",
    order: 40,
    settings: {
      summarySnapshots: setting.boolean({
        label: "Summary snapshots",
        default: true,
        order: 1,
        description: "Store original summarized entries inside summary details so expanded summary insets can still recover them after replacement/deletion.",
      }),
      snapshotToolResults: setting.enum({
        label: "Snapshot tool results",
        default: "truncated",
        choices: ["off", "truncated", "full"] as const,
        order: 2,
        description: "Controls whether tool/bash results are preserved in summary snapshots: off skips them, truncated keeps shortened output, full stores exact outputs.",
      }),
      toolResultTruncation: setting.number({
        label: "Tool result truncation",
        default: 20000,
        min: 1000,
        step: 1000,
        order: 3,
        description: "Maximum characters kept per large tool-output text field when Snapshot tool results is set to truncated.",
      }),
    },
  });

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
        const result = await (ctx.ui.custom as any)((tui: any, theme: Theme, _kb: any, done: (result?: ExitResult) => void) => new TreeEditComponent(draft, ctx, tui, theme, done), {
          overlay: true,
          overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", minWidth: 90, margin: 1 },
        });

        if (result?.action === "edit") {
          draft.checkpoint();
          await draft.editEntry(result.id, ctx);
          continue;
        }
        if (result?.action === "summarize") {
          draft.checkpoint();
          await draft.summarizeToClipboard(result.id, ctx, (draft as any).__lastFoldedIds ?? new Set(), (draft as any).__lastVisibleRangeEntries);
          delete (draft as any).__lastVisibleRangeEntries;
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
