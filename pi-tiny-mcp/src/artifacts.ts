import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipPath } from "pip-common";

function safePart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function sessionKey(ctx: any, cwd: string): string {
  const value = ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionManager?.getSessionFile?.() ?? cwd;
  return safePart(String(value));
}

export function writeTinyMcpArtifact(text: string, ctx: any, cwd: string): string {
  const dir = pipPath("tiny-mcp", "artifacts", sessionKey(ctx, cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.txt`);
  writeFileSync(path, text, "utf8");
  cleanupArtifacts(dir);
  return path;
}

function cleanupArtifacts(dir: string): void {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const files = readdirSync(dir)
    .map((name) => ({ name, path: join(dir, name) }))
    .filter((entry) => entry.name.endsWith(".txt"))
    .map((entry) => {
      try { return { ...entry, mtimeMs: statSync(entry.path).mtimeMs }; } catch { return undefined; }
    })
    .filter((entry): entry is { name: string; path: string; mtimeMs: number } => Boolean(entry))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const [index, file] of files.entries()) if (index >= 50 || file.mtimeMs < cutoff) rmSync(file.path, { force: true });
}
