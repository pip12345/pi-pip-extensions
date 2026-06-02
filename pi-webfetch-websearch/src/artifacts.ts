import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pipPath, truncateToWidth } from "../../pip-common/index.ts";
import { formatChars } from "./limits.ts";
import { settingValue } from "./settings.ts";

export const ARTIFACT_CUSTOM_TYPE = "pip.webfetchWebsearch.artifact";

export type ArtifactKind = "webfetch" | "websearch";

export interface ArtifactRecord {
  id: string;
  kind: ArtifactKind;
  path: string;
  url?: string;
  query?: string;
  title?: string;
  format?: string;
  chars: number;
  lines: number;
  createdAt: number;
  parentSessionKey: string;
  parentSessionFile?: string;
  kept?: boolean;
}

interface ArtifactIndex {
  version: 1;
  parentSessionKey: string;
  parentSessionFile?: string;
  artifacts: ArtifactRecord[];
}

function safePart(value: string): string {
  const slug = value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "unknown";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

export function sessionKey(ctx: any): { key: string; sessionFile?: string } {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  const id = sessionFile ?? ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionID ?? ctx?.sessionId ?? "unknown";
  return { key: String(id), sessionFile: typeof sessionFile === "string" ? sessionFile : undefined };
}

export function sessionArtifactDir(parentSessionKey: string): string {
  return pipPath("webfetch-websearch", "sessions", safePart(parentSessionKey));
}

function indexPath(parentSessionKey: string): string {
  return join(sessionArtifactDir(parentSessionKey), "artifacts.json");
}

function filesDir(parentSessionKey: string): string {
  return join(sessionArtifactDir(parentSessionKey), "files");
}

function readIndex(parentSessionKey: string, parentSessionFile?: string): ArtifactIndex {
  const path = indexPath(parentSessionKey);
  if (!existsSync(path)) return { version: 1, parentSessionKey, parentSessionFile, artifacts: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version !== 1 || parsed?.parentSessionKey !== parentSessionKey || !Array.isArray(parsed.artifacts)) throw new Error("invalid index");
    return { version: 1, parentSessionKey, parentSessionFile: parsed.parentSessionFile ?? parentSessionFile, artifacts: parsed.artifacts };
  } catch {
    return { version: 1, parentSessionKey, parentSessionFile, artifacts: [] };
  }
}

function writeIndex(index: ArtifactIndex): void {
  const dir = sessionArtifactDir(index.parentSessionKey);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "artifacts.json");
  const tmp = join(dir, `artifacts.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(index, null, 2));
  renameSync(tmp, target);
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function extFor(kind: ArtifactKind, format?: string): string {
  if (kind === "websearch") return "md";
  if (format === "html") return "html";
  if (format === "text") return "txt";
  return "md";
}

export interface OutlineItem {
  label: string;
  startLine: number;
  endLine: number;
}

export function buildOutline(text: string, kind: ArtifactKind, maxItems = 20): OutlineItem[] {
  const lines = text.split("\n");
  const starts: { label: string; startLine: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) starts.push({ label: `${heading[1]} ${heading[2]}`.slice(0, 160), startLine: i + 1 });
  }

  if (!starts.length && kind === "websearch") {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const result = /^(?:\d{1,2}[.)]|[-*]\s*(?:Result|Source)\b)\s+(.+?)\s*$/.exec(line);
      if (result) starts.push({ label: result[0].slice(0, 160), startLine: i + 1 });
    }
  }

  return starts.slice(0, maxItems).map((item, index, arr) => ({
    label: item.label,
    startLine: item.startLine,
    endLine: (arr[index + 1]?.startLine ?? lines.length + 1) - 1,
  }));
}

export function formatOutline(outline: OutlineItem[], maxItems = 12): string {
  if (!outline.length) return "Outline: no headings detected; use grep/read on the saved file.";
  const rows = outline.slice(0, maxItems).map((item, index) => `${index + 1}. ${truncateToWidth(item.label, 80)} — lines ${item.startLine}-${item.endLine}`);
  const suffix = outline.length > maxItems ? [`... ${outline.length - maxItems} more outline entries`] : [];
  return ["Outline:", ...rows, ...suffix].join("\n");
}

export function cleanupArtifacts(ctx: any): void {
  cleanupOrphanedSessions();
  const { key, sessionFile } = sessionKey(ctx);
  cleanupSession(key, sessionFile);
}

function cleanupOrphanedSessions(): void {
  const root = pipPath("webfetch-websearch", "sessions");
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "artifacts.json");
    if (!existsSync(path)) continue;
    try {
      const index = JSON.parse(readFileSync(path, "utf8"));
      if (index?.parentSessionFile && !existsSync(index.parentSessionFile)) rmSync(join(root, entry.name), { recursive: true, force: true });
    } catch {}
  }
}

function cleanupSession(parentSessionKey: string, parentSessionFile?: string, protectId?: string): void {
  const index = readIndex(parentSessionKey, parentSessionFile);
  const ttlHours = Number(settingValue("artifactTtlHours", 24));
  const maxPerSession = Number(settingValue("artifactMaxPerSession", 50));
  const now = Date.now();
  const ttlMs = Math.max(1, ttlHours) * 60 * 60 * 1000;
  let artifacts = index.artifacts.filter((artifact) => {
    const keep = artifact.kept || now - artifact.createdAt <= ttlMs;
    const exists = existsSync(artifact.path);
    if (!keep || !exists) rmSync(artifact.path, { force: true });
    return keep && exists;
  });
  const keepRecent = artifacts.filter((a) => !a.kept).sort((a, b) => {
    if (a.id === protectId) return -1;
    if (b.id === protectId) return 1;
    return b.createdAt - a.createdAt;
  }).slice(0, maxPerSession);
  const keepIds = new Set(keepRecent.map((a) => a.id));
  for (const artifact of artifacts) if (!artifact.kept && !keepIds.has(artifact.id)) rmSync(artifact.path, { force: true });
  artifacts = artifacts.filter((artifact) => artifact.kept || keepIds.has(artifact.id));
  if (artifacts.length !== index.artifacts.length) writeIndex({ ...index, parentSessionFile: parentSessionFile ?? index.parentSessionFile, artifacts });
}

export function writeArtifact(input: { kind: ArtifactKind; text: string; ctx: any; pi?: any; url?: string; query?: string; title?: string; format?: string }): { record: ArtifactRecord; outline: OutlineItem[] } {
  cleanupArtifacts(input.ctx);
  const { key, sessionFile } = sessionKey(input.ctx);
  const dir = filesDir(key);
  mkdirSync(dir, { recursive: true });
  const id = `${input.kind}_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const path = join(dir, `${id}.${extFor(input.kind, input.format)}`);
  writeFileSync(path, input.text, "utf8");
  const record: ArtifactRecord = {
    id,
    kind: input.kind,
    path,
    url: input.url,
    query: input.query,
    title: input.title,
    format: input.format,
    chars: input.text.length,
    lines: lineCount(input.text),
    createdAt: Date.now(),
    parentSessionKey: key,
    parentSessionFile: sessionFile,
  };
  // If the file was not written for any reason, fail before persisting the index/session entry.
  statSync(path);
  const index = readIndex(key, sessionFile);
  writeIndex({ ...index, parentSessionFile: sessionFile ?? index.parentSessionFile, artifacts: [...index.artifacts, record] });
  cleanupSession(key, sessionFile, record.id);
  input.pi?.appendEntry?.(ARTIFACT_CUSTOM_TYPE, record);
  return { record, outline: buildOutline(input.text, input.kind) };
}

export function artifactSummary(record: ArtifactRecord, outline: OutlineItem[]): string {
  return [
    `Saved ${record.kind} result: ${formatChars(record.chars)}, ${record.lines.toLocaleString()} lines`,
    `Path: ${record.path}`,
    "Use read, grep, or bash/sed on this file for focused inspection.",
    "",
    formatOutline(outline),
  ].join("\n");
}

export function artifactPathLabel(path: string): string {
  return basename(path);
}
