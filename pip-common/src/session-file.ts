import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { ensurePipSubdir } from "./paths.ts";

export type SessionHeader = { type: "session"; [key: string]: any };
export type SessionEntry = { type: string; id: string; parentId?: string | null; parent?: string | null; [key: string]: any };
export type SessionRecord = SessionHeader | SessionEntry | Record<string, any>;

export interface ParsedSessionFile {
  header: SessionHeader;
  entries: SessionEntry[];
  raw: SessionRecord[];
}

export interface BackupCleanupOptions {
  keepBackups?: number;
  maxAgeDays?: number | "never";
  now?: number;
}

export function isSessionEntry(record: SessionRecord): record is SessionEntry {
  return record.type !== "session" && typeof (record as any).id === "string";
}

export function parseSessionFile(path: string): ParsedSessionFile {
  const raw = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line)) as SessionRecord[];
  const header = raw.find((record) => record.type === "session") as SessionHeader | undefined;
  if (!header) throw new Error("Session file has no header");
  return { header, entries: raw.filter(isSessionEntry), raw };
}

export function serializeSessionRecords(records: SessionRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

export function serializeSessionFile(file: Pick<ParsedSessionFile, "header" | "entries">): string {
  return serializeSessionRecords([file.header, ...file.entries]);
}

export function writeSessionRecordsAtomic(path: string, records: SessionRecord[]): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, serializeSessionRecords(records));
  renameSync(tmp, path);
}

export function writeSessionFileAtomic(path: string, file: Pick<ParsedSessionFile, "header" | "entries">): void {
  writeSessionRecordsAtomic(path, [file.header, ...file.entries]);
}

export function hashSessionRecords(records: SessionRecord[]): string {
  return createHash("sha256").update(serializeSessionRecords(records)).digest("hex");
}

export function hashSessionFile(file: Pick<ParsedSessionFile, "header" | "entries">): string {
  return hashSessionRecords([file.header, ...file.entries]);
}

function timestampForBackup(now = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80) || "session";
}

export function backupSessionFile(path: string, reason: string, options: { backupDir?: string; now?: number } = {}): string {
  const backupDir = options.backupDir ?? ensurePipSubdir("backup", "undo-redo");
  mkdirSync(backupDir, { recursive: true });
  let out = join(backupDir, `${timestampForBackup(options.now)}-${safeName(basename(path))}-${safeName(reason)}.jsonl`);
  let counter = 1;
  while (existsSync(out)) {
    out = join(backupDir, `${timestampForBackup(options.now)}-${safeName(basename(path))}-${safeName(reason)}-${counter++}.jsonl`);
  }
  copyFileSync(path, out);
  return out;
}

export function cleanupBackups(dir: string, options: BackupCleanupOptions = {}): void {
  if (!existsSync(dir)) return;
  const keepBackups = options.keepBackups ?? 25;
  const maxAgeDays = options.maxAgeDays ?? 7;
  const now = options.now ?? Date.now();
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const path = join(dir, name);
      const stat = statSync(path);
      return { path, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (maxAgeDays !== "never") {
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const file of files) if (file.mtimeMs < cutoff) unlinkSync(file.path);
  }

  const remaining = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const path = join(dir, name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of remaining.slice(Math.max(0, keepBackups))) unlinkSync(file.path);
}

export function parentIdOf(entry: SessionEntry): string | null {
  return (entry.parentId ?? entry.parent ?? null) as string | null;
}

export function buildChildMap(entries: SessionEntry[]): Map<string | null, SessionEntry[]> {
  const children = new Map<string | null, SessionEntry[]>();
  for (const entry of entries) {
    const parentId = parentIdOf(entry);
    const list = children.get(parentId) ?? [];
    list.push(entry);
    children.set(parentId, list);
  }
  return children;
}

export function hasExternalChildren(tailIds: Set<string>, entries: SessionEntry[]): boolean {
  for (const entry of entries) {
    const parentId = parentIdOf(entry);
    if (parentId && tailIds.has(parentId) && !tailIds.has(entry.id)) return true;
  }
  return false;
}
