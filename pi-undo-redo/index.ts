import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  backupSessionFile,
  cleanupBackups,
  ensurePipSubdir,
  hasExternalChildren,
  hashSessionRecords,
  isSessionEntry,
  parseSessionFile,
  parentIdOf,
  pipSettings,
  registerSettingsSection,
  setting,
  textFromContent,
  writeSessionRecordsAtomic,
  type ParsedSessionFile,
  type SessionEntry,
  type SessionRecord,
} from "../pip-common/index.ts";

interface RedoSlot {
  sessionFile: string;
  promptText: string;
  removedEntries: SessionEntry[];
  previousLeafId: string | null;
  restoredLeafId: string;
  beforeUndoRecords: SessionRecord[];
  afterUndoHash: string;
  createdAt: number;
}

interface PendingRawPrompt {
  sessionFile: string;
  beforeLeafId: string | null;
  rawText: string;
  expandedText?: string;
  timestamp?: number;
}

const REDO_KEY = Symbol.for("pi-undo-redo.redo-stack");
const PENDING_RAW_KEY = Symbol.for("pi-undo-redo.pending-raw-prompt");
const SETTINGS_SECTION = "undo-redo";

type ExtensionAPI = any;
type Ctx = any;

function redoStack(): RedoSlot[] {
  const value = (globalThis as any)[REDO_KEY];
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function setRedoStack(stack: RedoSlot[]): void {
  const state = globalThis as any;
  if (stack.length) state[REDO_KEY] = stack;
  else delete state[REDO_KEY];
}

function clearRedoStack(): void {
  setRedoStack([]);
}

function pushRedoSlot(slot: RedoSlot): void {
  setRedoStack([...redoStack(), slot]);
}

function popRedoSlot(): RedoSlot | undefined {
  const stack = redoStack();
  const slot = stack.pop();
  setRedoStack(stack);
  return slot;
}

function redoSlot(): RedoSlot | undefined {
  return redoStack().at(-1);
}

function setRedoSlot(slot: RedoSlot | undefined): void {
  setRedoStack(slot ? [slot] : []);
}

function pendingRawPrompt(): PendingRawPrompt | undefined {
  return (globalThis as any)[PENDING_RAW_KEY];
}

function setPendingRawPrompt(value: PendingRawPrompt | undefined): void {
  const state = globalThis as any;
  if (value) state[PENDING_RAW_KEY] = value;
  else delete state[PENDING_RAW_KEY];
}

function rawPromptMapFile(): string {
  return join(ensurePipSubdir("undo-redo"), "raw-prompts.json");
}

function rawPromptKey(sessionFile: string, entryId: string): string {
  return `${sessionFile}#${entryId}`;
}

function readRawPromptMap(): Record<string, string> {
  const path = rawPromptMapFile();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeRawPromptMap(map: Record<string, string>): void {
  writeFileSync(rawPromptMapFile(), JSON.stringify(map, null, 2));
}

function rememberRawPrompt(sessionFile: string, entryId: string, rawText: string): void {
  if (!rawText.trim()) return;
  const map = readRawPromptMap();
  map[rawPromptKey(sessionFile, entryId)] = rawText;
  writeRawPromptMap(map);
}

function recalledRawPrompt(sessionFile: string | undefined, entryId: string): string | undefined {
  if (!sessionFile) return undefined;
  return readRawPromptMap()[rawPromptKey(sessionFile, entryId)];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function isUserEntry(entry: any): entry is SessionEntry {
  return entry?.type === "message" && entry.message?.role === "user";
}

function parseSkillInvocation(text: string): { name: string; userMessage?: string } | null {
  const match = text.match(/^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return { name: match[1], userMessage: match[2]?.trim() || undefined };
}

function promptText(entry: SessionEntry, sessionFile?: string): string {
  const raw = recalledRawPrompt(sessionFile, entry.id);
  if (raw) return raw;
  const text = textFromContent((entry as any).message?.content, "\n");
  const skill = parseSkillInvocation(text);
  if (skill) return skill.userMessage ? `/skill:${skill.name} ${skill.userMessage}` : `/skill:${skill.name}`;
  return text;
}

function sessionFileFromCtx(ctx: Ctx): string | undefined {
  return ctx.sessionManager.getSessionFile?.();
}

function leafFromCtx(ctx: Ctx, branch: any[]): string | undefined {
  return ctx.sessionManager.getLeafId?.() ?? branch.at(-1)?.id;
}

function updateHeaderLeaf(header: any, leafId: string | null): void {
  for (const key of ["leafId", "currentLeafId", "activeLeafId"]) {
    if (key in header) header[key] = leafId;
  }
}

function headerLeafValues(header: any): Array<string | null> {
  return ["leafId", "currentLeafId", "activeLeafId"].filter((key) => key in header).map((key) => header[key] ?? null);
}

function backupOptions() {
  const keep = Number.parseInt(String(getSetting("keepBackups", "25")), 10) || 25;
  const maxAge = getSetting("backupMaxAgeDays", "7");
  return { keepBackups: keep, maxAgeDays: maxAge === "never" ? "never" as const : Number.parseInt(String(maxAge), 10) || 7 };
}

function getSetting(key: string, fallback: unknown): unknown {
  try {
    return pipSettings.get(`${SETTINGS_SECTION}.${key}`);
  } catch {
    return fallback;
  }
}

function settingsEnabled(): boolean {
  return getSetting("enabled", true) !== false;
}

export interface UndoPlan {
  target: SessionEntry;
  tail: SessionEntry[];
  previousLeafId: string | null;
  restoredLeafId: string;
  promptText: string;
}

export function planUndo(branch: SessionEntry[], allEntries: SessionEntry[], leafId?: string, sessionFile?: string): UndoPlan {
  if (!branch.length) throw new Error("Nothing to undo.");
  const currentLeafId = leafId ?? branch.at(-1)?.id;
  if (!currentLeafId || branch.at(-1)?.id !== currentLeafId) throw new Error("Cannot undo: current leaf mismatch.");

  let targetIndex = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (isUserEntry(branch[i])) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex < 0) throw new Error("Nothing to undo.");

  const tail = branch.slice(targetIndex);
  const tailIds = new Set(tail.map((entry) => entry.id));
  const allIds = new Set(allEntries.map((entry) => entry.id));
  for (const id of tailIds) if (!allIds.has(id)) throw new Error("Cannot undo: session file is out of sync.");
  if (tail.at(-1)?.id !== currentLeafId) throw new Error("Cannot undo: target is not at the current branch tip.");
  if (hasExternalChildren(tailIds, allEntries)) throw new Error("Cannot undo: this message is not at the end of a branch.");

  const target = tail[0];
  const previousLeafId = parentIdOf(target);
  return { target, tail, previousLeafId, restoredLeafId: currentLeafId, promptText: promptText(target, sessionFile) };
}

function backupAndCleanup(sessionFile: string, reason: string): void {
  const dir = ensurePipSubdir("backup", "undo-redo");
  backupSessionFile(sessionFile, reason, { backupDir: dir });
  cleanupBackups(dir, backupOptions());
}

async function replaceCurrentSession(ctx: Ctx, sessionFile: string, withSession?: (ctx: Ctx) => Promise<void> | void): Promise<void> {
  if (typeof ctx.switchSession === "function") {
    await ctx.switchSession(sessionFile, { withSession });
    return;
  }
  await ctx.reload?.();
  await withSession?.(ctx);
}

function makeEffectiveLeafLast(records: SessionRecord[], leafId: string | null): SessionRecord[] {
  if (!leafId) return records;
  const leafIndex = records.findIndex((record) => isSessionEntry(record) && record.id === leafId);
  if (leafIndex < 0 || leafIndex === records.length - 1) return records;
  const next = [...records];
  const [leaf] = next.splice(leafIndex, 1);
  next.push(leaf);
  return next;
}

function removeTail(file: ParsedSessionFile, tail: SessionEntry[], previousLeafId: string | null): SessionRecord[] {
  const tailIds = new Set(tail.map((entry) => entry.id));
  const header = clone(file.header);
  updateHeaderLeaf(header, previousLeafId);
  const records = file.raw
    .map((record) => (record.type === "session" ? header : record))
    .filter((record) => !(isSessionEntry(record) && tailIds.has(record.id)));
  return makeEffectiveLeafLast(records, previousLeafId);
}

function restoreTail(_file: ParsedSessionFile, slot: RedoSlot): SessionRecord[] {
  const records = clone(slot.beforeUndoRecords);
  return makeEffectiveLeafLast(records, slot.restoredLeafId);
}

async function undo(ctx: Ctx) {
  if (!settingsEnabled()) return ctx.ui.notify("Undo/redo is disabled.", "warning");
  if (ctx.isIdle?.() === false) return ctx.ui.notify("Cannot undo while pi is running.", "warning");
  const sessionFile = sessionFileFromCtx(ctx);
  if (!sessionFile) return ctx.ui.notify("Cannot undo: no session file.", "warning");

  const branch = ctx.sessionManager.getBranch?.() ?? [];
  const currentLeafId = leafFromCtx(ctx, branch);
  const file = parseSessionFile(sessionFile);
  const fileLeafValues = headerLeafValues(file.header);
  if (fileLeafValues.some((fileLeaf) => fileLeaf !== currentLeafId)) throw new Error("Cannot undo: session file is out of sync.");
  const plan = planUndo(branch, file.entries, currentLeafId, sessionFile);
  const nextRecords = removeTail(file, plan.tail, plan.previousLeafId);

  backupAndCleanup(sessionFile, "undo");
  writeSessionRecordsAtomic(sessionFile, nextRecords);
  pushRedoSlot({
    sessionFile,
    promptText: plan.promptText,
    removedEntries: clone(plan.tail),
    previousLeafId: plan.previousLeafId,
    restoredLeafId: plan.restoredLeafId,
    beforeUndoRecords: clone(file.raw),
    afterUndoHash: hashSessionRecords(nextRecords),
    createdAt: Date.now(),
  });
  await replaceCurrentSession(ctx, sessionFile, async (newCtx) => {
    newCtx.ui.setEditorText?.(plan.promptText);
    newCtx.ui.notify(`Undid latest prompt. Use /redo to restore it.`, "info");
  });
}

async function redo(ctx: Ctx) {
  if (!settingsEnabled()) return ctx.ui.notify("Undo/redo is disabled.", "warning");
  if (ctx.isIdle?.() === false) return ctx.ui.notify("Cannot redo while pi is running.", "warning");
  const slot = redoSlot();
  if (!slot) return ctx.ui.notify("Nothing to redo.", "info");
  const sessionFile = sessionFileFromCtx(ctx);
  if (!sessionFile || sessionFile !== slot.sessionFile) {
    clearRedoStack();
    return ctx.ui.notify("Cannot redo: session changed.", "warning");
  }

  const file = parseSessionFile(sessionFile);
  if (hashSessionRecords(file.raw) !== slot.afterUndoHash) {
    clearRedoStack();
    return ctx.ui.notify("Cannot redo: session changed.", "warning");
  }

  const poppedSlot = popRedoSlot();
  if (!poppedSlot) return ctx.ui.notify("Nothing to redo.", "info");
  const nextRecords = restoreTail(file, poppedSlot);
  backupAndCleanup(sessionFile, "redo");
  writeSessionRecordsAtomic(sessionFile, nextRecords);
  await replaceCurrentSession(ctx, sessionFile, async (newCtx) => {
    newCtx.ui.notify("Redid latest undone prompt.", "info");
  });
}

export default function undoRedoExtension(pi: ExtensionAPI) {
  registerSettingsSection({
    id: SETTINGS_SECTION,
    title: "Undo / Redo",
    description: "Tail-only /undo and /redo with safety backups.",
    order: 60,
    settings: {
      enabled: setting.boolean({ default: true, label: "Enabled", order: 1, description: "Enable /undo and /redo for the current branch tip." }),
      keepBackups: setting.enum({ default: "25", choices: ["10", "25", "50", "100"], label: "Keep backups", order: 2, description: "Maximum number of undo/redo backup files to keep." }),
      backupMaxAgeDays: setting.enum({ default: "7", choices: ["1", "7", "30", "never"], label: "Backup max age", order: 3, description: "Delete older backup files after this many days, or never by age." }),
    },
  });

  pi.registerCommand("undo", {
    description: "Permanently remove the latest prompt at the end of the current branch and restore it to the editor",
    handler: async (_args: string, ctx: Ctx) => {
      try {
        await undo(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  pi.registerCommand("redo", {
    description: "Restore the exact prompt/response removed by /undo",
    handler: async (_args: string, ctx: Ctx) => {
      try {
        await redo(ctx);
      } catch (error) {
        clearRedoStack();
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  pi.on("input", (event: any, ctx: Ctx) => {
    const rawText = String(event.text ?? "");
    const text = rawText.trim();
    if (text === "/undo" || text.startsWith("/undo ") || text === "/redo" || text.startsWith("/redo ")) return;
    clearRedoStack();
    const sessionFile = sessionFileFromCtx(ctx);
    if (!sessionFile) return;
    setPendingRawPrompt({ sessionFile, beforeLeafId: ctx.sessionManager.getLeafId?.() ?? null, rawText });
  });

  pi.on("message_end", (event: any) => {
    const pending = pendingRawPrompt();
    if (!pending || event.message?.role !== "user") return;
    pending.expandedText = textFromContent(event.message.content, "\n");
    pending.timestamp = typeof event.message.timestamp === "number" ? event.message.timestamp : undefined;
    setPendingRawPrompt(pending);
  });

  pi.on("turn_end", (_event: any, ctx: Ctx) => {
    const pending = pendingRawPrompt();
    if (!pending) return;
    const sessionFile = sessionFileFromCtx(ctx);
    if (!sessionFile || sessionFile !== pending.sessionFile) return setPendingRawPrompt(undefined);
    try {
      const file = parseSessionFile(sessionFile);
      const candidates = file.entries.filter((entry) => isUserEntry(entry) && parentIdOf(entry) === pending.beforeLeafId);
      const match = candidates.find((entry) => textFromContent((entry as any).message?.content, "\n") === pending.expandedText) ?? candidates.at(-1);
      if (match) rememberRawPrompt(sessionFile, match.id, pending.rawText);
    } finally {
      setPendingRawPrompt(undefined);
    }
  });
}

export const __test = { planUndo, redoSlot, setRedoSlot, redoStack, setRedoStack, removeTail, restoreTail, rememberRawPrompt, recalledRawPrompt };
