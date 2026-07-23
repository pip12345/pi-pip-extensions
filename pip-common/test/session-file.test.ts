import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { backupSessionFile, cleanupBackups, hasExternalChildren, hashSessionFile, makeEffectiveLeafLast, parseSessionFile, serializeSessionFile, sessionHeaderLeafValues, setSessionHeaderLeaf, writeSessionFileAtomic, type SessionEntry } from "../src/session-file.ts";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "pip-session-file-"));
}

describe("session file helpers", () => {
  it("parses, serializes, hashes, and writes atomically", () => {
    const dir = tempDir();
    const path = join(dir, "session.jsonl");
    const file = { header: { type: "session" as const, leafId: "a" }, entries: [{ type: "message", id: "a", parentId: null }] };
    writeFileSync(path, serializeSessionFile(file));
    const parsed = parseSessionFile(path);
    expect(parsed.header.leafId).toBe("a");
    expect(parsed.entries).toHaveLength(1);
    const before = hashSessionFile(parsed);
    writeSessionFileAtomic(path, { header: parsed.header, entries: [...parsed.entries, { type: "message", id: "b", parentId: "a" }] });
    expect(hashSessionFile(parseSessionFile(path))).not.toBe(before);
    expect(readFileSync(path, "utf8")).toContain('"id":"b"');
  });

  it("makes the selected leaf the effective final record and updates known header fields", () => {
    const header = { type: "session" as const, leafId: "old", currentLeafId: "old" };
    const a = { type: "message", id: "a", parentId: null };
    const b = { type: "message", id: "b", parentId: "a" };
    setSessionHeaderLeaf(header, "a");
    const records = makeEffectiveLeafLast([header, a, b], "a");
    expect(records.at(-1)).toBe(a);
    expect(sessionHeaderLeafValues(header)).toEqual(["a", "a"]);
  });

  it("leaves the original target intact and removes temporary files when replacement fails", () => {
    const dir = tempDir();
    const target = join(dir, "session.jsonl");
    mkdirSync(target);
    expect(() => writeSessionFileAtomic(target, { header: { type: "session" }, entries: [] })).toThrow();
    expect(existsSync(target)).toBe(true);
    expect(readdirSync(dir)).toEqual(["session.jsonl"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects external children of a tail", () => {
    const entries: SessionEntry[] = [
      { type: "message", id: "u1", parentId: null },
      { type: "message", id: "a1", parentId: "u1" },
      { type: "message", id: "u2", parentId: "a1" },
      { type: "message", id: "a2", parentId: "u2" },
      { type: "message", id: "branch", parentId: "a2" },
    ];
    expect(hasExternalChildren(new Set(["u2", "a2"]), entries)).toBe(true);
    expect(hasExternalChildren(new Set(["u2", "a2", "branch"]), entries)).toBe(false);
  });

  it("does not overwrite backups created in the same millisecond", () => {
    const dir = tempDir();
    const source = join(dir, "session.jsonl");
    const backupDir = join(dir, "backups");
    writeFileSync(source, "x");
    const one = backupSessionFile(source, "undo", { backupDir, now: 1_700_000_000_000 });
    const two = backupSessionFile(source, "undo", { backupDir, now: 1_700_000_000_000 });
    expect(two).not.toBe(one);
  });

  it("cleans old backups and keeps newest files", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const path = join(dir, `${i}.jsonl`);
      writeFileSync(path, "x");
      const t = new Date(now - i * 1000);
      utimesSync(path, t, t);
    }
    cleanupBackups(dir, { keepBackups: 2, maxAgeDays: "never", now });
    expect(readFileSync(join(dir, "0.jsonl"), "utf8")).toBe("x");
    expect(readFileSync(join(dir, "1.jsonl"), "utf8")).toBe("x");
  });
});
