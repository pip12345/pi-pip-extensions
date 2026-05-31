import { pipSettings, hasTextContent, stripAnsi, textFromContent as commonTextFromContent } from "../pip-common/index.ts";
import { EXT, SUMMARY_CUSTOM_TYPE, TREE_EDIT_SETTINGS_ID, type Clipboard, type Entry, type FilterMode, type SnapshotToolResults, type SummarySnapshotPolicy, type TreeGutter, type TreeRow } from "./types.ts";

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}


export function textFromContent(content: any): string {
  return commonTextFromContent(content, "\n");
}

export function entryText(entry: Entry): string {
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

export function entryKind(entry: Entry): string {
  if (entry.type === "message") return entry.message?.role || "message";
  return entry.type;
}

export function isVisibleEntry(entry: Entry, mode: FilterMode, labels: Map<string, string>): boolean {
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

export function compactLine(value: string): string {
  return stripAnsi(value).replace(/\s+/g, " ").trim();
}

export function getSummarySettings(): SummarySnapshotPolicy {
  return {
    summarySnapshots: Boolean(pipSettings.get(`${TREE_EDIT_SETTINGS_ID}.summarySnapshots`)),
    snapshotToolResults: pipSettings.get<SnapshotToolResults>(`${TREE_EDIT_SETTINGS_ID}.snapshotToolResults`),
    toolResultTruncation: pipSettings.get<number>(`${TREE_EDIT_SETTINGS_ID}.toolResultTruncation`),
  };
}

export function isSummaryEntry(entry: Entry): boolean {
  return entry.type === "custom_message" && entry.customType === SUMMARY_CUSTOM_TYPE && entry.details?.kind === "summary";
}

export function isToolLikeEntry(entry: Entry): boolean {
  const role = entry.type === "message" ? entry.message?.role : undefined;
  return role === "toolResult" || role === "bashExecution";
}

export function isNormalMessageEntry(entry: Entry | undefined): entry is Entry {
  const role = entry?.type === "message" ? entry.message?.role : undefined;
  return role === "user" || role === "assistant";
}

export function truncateStrings(value: any, limit: number): any {
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}\n...[truncated by ${EXT}: ${value.length - limit} chars omitted]` : value;
  if (Array.isArray(value)) return value.map((item) => truncateStrings(item, limit));
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [key, child] of Object.entries(value)) out[key] = truncateStrings(child, limit);
    return out;
  }
  return value;
}

export function snapshotEntries(entries: Entry[], policy: SummarySnapshotPolicy): Entry[] | undefined {
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

export function summaryDetails(entry: Entry): any | undefined {
  return isSummaryEntry(entry) ? entry.details : undefined;
}

export function summarySourceIds(entry: Entry): string[] {
  const ids = summaryDetails(entry)?.sourceEntryIds;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
}

export function createSummaryEntry(clipboard: Extract<Clipboard, { kind: "summary" }>, id: string, parentId: string | null, timestamp: string): Entry {
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

export function missingSourceEntry(summaryEntry: Entry, sourceEntryId: string): Entry {
  return { type: "custom", id: `missing:${summaryEntry.id}:${sourceEntryId}`, parentId: summaryEntry.id, timestamp: summaryEntry.timestamp, customType: "missing-summary-source", data: { sourceEntryId } };
}

export function resolveSummarySourceRows(summaryEntry: Entry, allEntries: Entry[]): Array<{ entry: Entry; fromSnapshot: boolean; missing: boolean; sourceEntryId: string }> {
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

export function rowKey(row: TreeRow): string {
  return row.virtual ? `virtual:${row.virtual.summaryEntryId}:${row.virtual.sourceEntryId}` : row.entry.id;
}

export function estimateTokensForEntries(entries: Entry[]): number {
  const chars = entries.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

export function estimateContextTokensForEntry(entry: Entry): number {
  if (entry.type === "message") return Math.max(1, Math.ceil((entryText(entry).length + 12) / 4));
  if (entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary") return Math.max(1, Math.ceil((entryText(entry).length + 12) / 4));
  return 0;
}

export function contextUsageFromMessage(message: any): number {
  const usage = message?.usage;
  if (!usage) return 0;
  return Math.max(0, Math.ceil(usage.totalTokens || (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0)));
}

export function contextPercentByEntry(entries: Entry[], contextWindow: number): Map<string, number> {
  const out = new Map<string, number>();
  if (!contextWindow || contextWindow <= 0) return out;
  const byId = entryMap(entries);
  type ContextState = { baseline: number; trailing: number };
  const stateMemo = new Map<string, ContextState>();

  const stateForEntry = (entry: Entry): ContextState => {
    const cached = stateMemo.get(entry.id);
    if (cached) return cached;

    const chain: Entry[] = [];
    const seen = new Set<string>();
    let cur: Entry | undefined = entry;
    let parentState: ContextState = { baseline: 0, trailing: 0 };

    while (cur) {
      const cachedState = stateMemo.get(cur.id);
      if (cachedState) {
        parentState = cachedState;
        break;
      }
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      chain.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }

    let state = parentState;
    for (let i = chain.length - 1; i >= 0; i--) {
      const current = chain[i];
      let next: ContextState;
      if (current.type === "message" && current.message?.role === "assistant" && current.message?.stopReason !== "aborted" && current.message?.stopReason !== "error") {
        const usageTokens = contextUsageFromMessage(current.message);
        next = usageTokens > 0 ? { baseline: usageTokens, trailing: 0 } : { baseline: state.baseline, trailing: state.trailing + estimateContextTokensForEntry(current) };
      } else {
        next = { baseline: state.baseline, trailing: state.trailing + estimateContextTokensForEntry(current) };
      }
      stateMemo.set(current.id, next);
      state = next;
    }
    return stateMemo.get(entry.id) ?? state;
  };

  for (const entry of entries) {
    const state = stateForEntry(entry);
    out.set(entry.id, Math.min(999, Math.round(((state.baseline + state.trailing) / contextWindow) * 100)));
  }
  return out;
}

export function messagesFromEntries(entries: Entry[]): any[] {
  return entries.flatMap((entry) => entry.type === "message" && entry.message ? [entry.message] : []);
}

export function buildLabels(entries: Entry[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "label") continue;
    if (entry.label) labels.set(entry.targetId, entry.label);
    else labels.delete(entry.targetId);
  }
  return labels;
}

export function childrenMap(entries: Entry[]): Map<string | null, Entry[]> {
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

export function activePathIds(entries: Entry[], leafId: string | null): Set<string> {
  const byId = entryMap(entries);
  const active = new Set<string>();
  let cur = leafId ? byId.get(leafId) : undefined;
  while (cur && !active.has(cur.id)) {
    active.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return active;
}

export function flattenEntries(entries: Entry[], activeIds: Set<string> = new Set()): Array<{ entry: Entry }> {
  const children = childrenMap(entries);
  const out: Array<{ entry: Entry }> = [];
  const seen = new Set<string>();
  const ordered = (items: Entry[]) => [...items].sort((a, b) => Number(activeIds.has(b.id)) - Number(activeIds.has(a.id)) || Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const visit = (start: Entry) => {
    const stack = [start];
    while (stack.length) {
      const entry = stack.pop()!;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push({ entry });
      const orderedChildren = ordered(children.get(entry.id) ?? []);
      for (let i = orderedChildren.length - 1; i >= 0; i--) stack.push(orderedChildren[i]);
    }
  };
  for (const root of ordered(children.get(null) ?? [])) visit(root);
  for (const entry of entries) if (!seen.has(entry.id)) visit(entry);
  return out;
}

export function visibleRows(entries: Entry[], mode: FilterMode, foldedIds: Set<string> = new Set(), searchQuery = "", activeLeafId: string | null = null): TreeRow[] {
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

export function expandSummaryRows(rows: TreeRow[], entries: Entry[], expandedSummaryIds: Set<string>): TreeRow[] {
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

export function descendantsOf(entries: Entry[], id: string): Set<string> {
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

export function entryMap(entries: Entry[]): Map<string, Entry> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

export function pathToRoot(entries: Entry[], id: string): Entry[] {
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

export function pathBetween(entries: Entry[], a: string, b: string): Entry[] | null {
  const pa = pathToRoot(entries, a);
  const pb = pathToRoot(entries, b);
  const ia = pa.findIndex((e) => e.id === b);
  if (ia >= 0) return pa.slice(ia);
  const ib = pb.findIndex((e) => e.id === a);
  if (ib >= 0) return pb.slice(ib);
  return null;
}

export function nearestExistingParent(original: Entry[], removed: Set<string>, id: string | null): string | null {
  const byId = entryMap(original);
  let cur = id ? byId.get(id) : undefined;
  while (cur) {
    if (!removed.has(cur.id)) return cur.id;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return null;
}
