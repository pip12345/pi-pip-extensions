import { rmSync } from "node:fs";

import {
  backupSessionFile,
  cleanupBackups,
  ensurePipSubdir,
  hasExternalChildren,
  hashSessionRecords,
  isSessionEntry,
  makeEffectiveLeafLast,
  parseSessionFile,
  parentIdOf,
  pipPath,
  registerSettingsSection,
  sessionHeaderLeafValues,
  setSessionHeaderLeaf,
  settingsFor,
  type ScopedSettings,
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
}

const REDO_KEY = Symbol.for("pi-undo-redo.redo-stack");
const PENDING_RAW_KEY = Symbol.for("pi-undo-redo.pending-raw-prompt");
const SETTINGS_SECTION = "undo-redo";
const RAW_PROMPT_CUSTOM_TYPE = "pip.undo-redo.raw-prompt";
const MAX_RAW_PROMPT_CHARS = 64 * 1024;

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

function recalledRawPrompt(entries: readonly SessionEntry[], entryId: string): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== RAW_PROMPT_CUSTOM_TYPE) continue;
    if (entry.data?.messageId !== entryId || typeof entry.data?.rawText !== "string") continue;
    if (entry.data.rawText.length > MAX_RAW_PROMPT_CHARS) continue;
    return entry.data.rawText;
  }
  return undefined;
}

function rawPromptForStorage(pending: PendingRawPrompt): string | undefined {
  if (!pending.rawText.trim() || pending.rawText === pending.expandedText) return undefined;
  return pending.rawText.length <= MAX_RAW_PROMPT_CHARS ? pending.rawText : undefined;
}

function cleanupLegacyRawPromptMap(path = pipPath("undo-redo", "raw-prompts.json")): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // The legacy cache is non-authoritative; an unreadable file must not block startup.
  }
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

function promptText(entry: SessionEntry, entries: readonly SessionEntry[]): string {
  const raw = recalledRawPrompt(entries, entry.id);
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

function backupOptions(settings: ScopedSettings) {
  const keep = Number.parseInt(String(settings.get<string>("keepBackups", "25")), 10) || 25;
  const maxAge = settings.get<string>("backupMaxAgeDays", "7");
  return { keepBackups: keep, maxAgeDays: maxAge === "never" ? "never" as const : Number.parseInt(String(maxAge), 10) || 7 };
}

function settingsEnabled(settings: ScopedSettings): boolean {
  return settings.get<boolean>("enabled", true) !== false;
}

export interface UndoPlan {
  target: SessionEntry;
  tail: SessionEntry[];
  previousLeafId: string | null;
  restoredLeafId: string;
  promptText: string;
}

export function planUndo(branch: SessionEntry[], allEntries: SessionEntry[], leafId?: string): UndoPlan {
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
  return { target, tail, previousLeafId, restoredLeafId: currentLeafId, promptText: promptText(target, allEntries) };
}

function backupAndCleanup(sessionFile: string, reason: string, settings: ScopedSettings): void {
  const dir = ensurePipSubdir("backup", "undo-redo");
  backupSessionFile(sessionFile, reason, { backupDir: dir });
  cleanupBackups(dir, backupOptions(settings));
}

async function replaceCurrentSession(ctx: Ctx, sessionFile: string, withSession?: (ctx: Ctx) => Promise<void> | void): Promise<void> {
  if (typeof ctx.switchSession === "function") {
    await ctx.switchSession(sessionFile, { withSession });
    return;
  }
  await ctx.reload?.();
  await withSession?.(ctx);
}

function removeTail(file: ParsedSessionFile, tail: SessionEntry[], previousLeafId: string | null): SessionRecord[] {
  const tailIds = new Set(tail.map((entry) => entry.id));
  const header = clone(file.header);
  setSessionHeaderLeaf(header, previousLeafId);
  const records = file.raw
    .map((record) => (record.type === "session" ? header : record))
    .filter((record) => !(isSessionEntry(record) && tailIds.has(record.id)));
  return makeEffectiveLeafLast(records, previousLeafId);
}

function restoreTail(_file: ParsedSessionFile, slot: RedoSlot): SessionRecord[] {
  const records = clone(slot.beforeUndoRecords);
  return makeEffectiveLeafLast(records, slot.restoredLeafId);
}

async function undo(ctx: Ctx, settings: ScopedSettings) {
  if (!settingsEnabled(settings)) return ctx.ui.notify("Undo/redo is disabled.", "warning");
  if (ctx.isIdle?.() === false) return ctx.ui.notify("Cannot undo while pi is running.", "warning");
  const sessionFile = sessionFileFromCtx(ctx);
  if (!sessionFile) return ctx.ui.notify("Cannot undo: no session file.", "warning");

  const branch = ctx.sessionManager.getBranch?.() ?? [];
  const currentLeafId = leafFromCtx(ctx, branch);
  const file = parseSessionFile(sessionFile);
  const fileLeafValues = sessionHeaderLeafValues(file.header);
  if (fileLeafValues.some((fileLeaf) => fileLeaf !== currentLeafId)) throw new Error("Cannot undo: session file is out of sync.");
  const plan = planUndo(branch, file.entries, currentLeafId);
  const nextRecords = removeTail(file, plan.tail, plan.previousLeafId);

  backupAndCleanup(sessionFile, "undo", settings);
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

async function redo(ctx: Ctx, settings: ScopedSettings) {
  if (!settingsEnabled(settings)) return ctx.ui.notify("Undo/redo is disabled.", "warning");
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
  backupAndCleanup(sessionFile, "redo", settings);
  writeSessionRecordsAtomic(sessionFile, nextRecords);
  await replaceCurrentSession(ctx, sessionFile, async (newCtx) => {
    newCtx.ui.notify("Redid latest undone prompt.", "info");
  });
}

export default function undoRedoExtension(pi: ExtensionAPI) {
  registerSettingsSection(pi, {
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

  const settings = settingsFor(pi, SETTINGS_SECTION);

  pi.registerCommand("undo", {
    description: "Permanently remove the latest prompt at the end of the current branch and restore it to the editor",
    handler: async (_args: string, ctx: Ctx) => {
      try {
        await undo(ctx, settings);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  pi.registerCommand("redo", {
    description: "Restore the exact prompt/response removed by /undo",
    handler: async (_args: string, ctx: Ctx) => {
      try {
        await redo(ctx, settings);
      } catch (error) {
        clearRedoStack();
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  pi.on("session_start", () => cleanupLegacyRawPromptMap());

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
      const rawText = match ? rawPromptForStorage(pending) : undefined;
      if (match && rawText) pi.appendEntry(RAW_PROMPT_CUSTOM_TYPE, { version: 1, messageId: match.id, rawText });
    } finally {
      setPendingRawPrompt(undefined);
    }
  });
}

export const __test = { RAW_PROMPT_CUSTOM_TYPE, MAX_RAW_PROMPT_CHARS, planUndo, redoSlot, setRedoSlot, redoStack, setRedoStack, removeTail, restoreTail, recalledRawPrompt, rawPromptForStorage, cleanupLegacyRawPromptMap };
