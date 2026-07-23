export type ExtensionAPI = any;
export type Theme = any;
export type Ctx = any;

export type Header = { type: "session"; [key: string]: any };
export type Entry = { type: string; id: string; parentId: string | null; timestamp: string; [key: string]: any };
export type FileEntry = Header | Entry;
export type SnapshotToolResults = "off" | "truncated" | "full";
export type SummarySnapshotPolicy = { summarySnapshots: boolean; snapshotToolResults: SnapshotToolResults; toolResultTruncation: number };
export type Clipboard =
  | { kind: "entries"; entries: Entry[]; label: string; structure?: "linear" | "preserve"; sourceEntryIds: string[] }
  | { kind: "summary"; summary: string; sourceEntryIds: string[]; sourceEntries?: Entry[]; label: string; snapshotPolicy: SummarySnapshotPolicy };

export type ExitResult =
  | { action: "quit" }
  | { action: "edit"; id: string }
  | { action: "summarize"; id: string; foldedIds: Set<string>; visibleRangeEntries: Entry[] }
  | { action: "compact"; id: string }
  | { action: "label"; id: string };
export type FilterMode = "default" | "show-tools" | "user-only" | "labeled-only" | "all";
export type TreeGutter = { position: number; show: boolean };
export type SummarySourceVirtualRow = { kind: "summary-source"; summaryEntryId: string; sourceEntryId: string; fromSnapshot: boolean; missing?: boolean };
export type TreeRow = { entry: Entry; depth: number; isLast: boolean; gutters: TreeGutter[]; showConnector: boolean; isVirtualRootChild: boolean; foldable: boolean; folded: boolean; multipleRoots: boolean; activePath: boolean; virtual?: SummarySourceVirtualRow };
export type DraftSnapshot = { entries: Entry[]; targetLeafId: string | null; clipboard: Clipboard | null; markId: string | null; dirty: boolean };

export const EXT = "pi-tree-edit";
export const SUMMARY_CUSTOM_TYPE = "pi-tree-edit.summary";
export const HELP_ITEMS = [
  "j/k move", "Ctrl+←/→ fold",
  "/ search", "f filter",
  "Enter/b set current location",
  "v start/cancel range",
  "i include branches",
  "y copy",
  "c cut",
  "C compact before",
  "S summarize",
  "o open summary",
  "p paste after",
  "P paste as new branch",
  "d delete",
  "D delete branch",
  "t prune tools",
  "e edit",
  "L edit label",
  "u undo",
  "U redo",
  "q quit",
];
