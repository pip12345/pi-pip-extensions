import { readFileSync } from "node:fs";
import { type Entry, type FileEntry, type Header } from "./types.ts";
import { clone, entryMap } from "./tree.ts";

export function isEntry(value: FileEntry): value is Entry {
  return value.type !== "session";
}

export function parseSessionFile(path: string): { header: Header; entries: Entry[]; raw: FileEntry[] } {
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
  const raw = lines.map((line) => JSON.parse(line)) as FileEntry[];
  const header = raw.find((entry) => entry.type === "session") as Header | undefined;
  if (!header) throw new Error("Session file has no header");
  return { header: clone(header), entries: raw.filter(isEntry).map(clone), raw };
}

export function timestampForFile(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}


export function validateDraft(header: Header, entries: Entry[]): string[] {
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
