import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { pipPath } from "../../../pip-common/index.ts";

export const USAGE_MAINTENANCE_LOCK_DIR = pipPath("usage", ".maintenance.lock");

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  createdAt: number;
}

function ownerToken(): string {
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function currentOwner(): LockOwner {
  return { token: ownerToken(), pid: process.pid, hostname: hostname(), createdAt: Date.now() };
}

function ownerPath(path: string): string {
  return join(path, "owner.json");
}

function readOwner(path: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(ownerPath(path), "utf8"));
    if (typeof parsed?.token === "string" && typeof parsed?.pid === "number" && typeof parsed?.hostname === "string") return parsed;
  } catch {}
  return undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== "ESRCH";
  }
}

function recoverDeadOwnerLock(path: string): void {
  const owner = readOwner(path);
  if (!owner) return;
  if (owner.hostname !== hostname()) return;
  if (processIsAlive(owner.pid)) return;
  // Only break locks whose recorded process is definitely gone.
  rmSync(path, { recursive: true, force: true });
}

function lockOwnedBy(path: string, owner: LockOwner): boolean {
  const current = readOwner(path);
  return !!current && current.token === owner.token && current.pid === owner.pid && current.hostname === owner.hostname;
}

function releaseOwnedLock(path: string, owner: LockOwner): void {
  if (!lockOwnedBy(path, owner)) return;
  rmSync(path, { recursive: true, force: true });
}

export function withUsageMaintenanceLock<T>(fn: () => T): T | undefined {
  const owner = currentOwner();
  let created = false;
  try {
    mkdirSync(dirname(USAGE_MAINTENANCE_LOCK_DIR), { recursive: true });
    recoverDeadOwnerLock(USAGE_MAINTENANCE_LOCK_DIR);
    mkdirSync(USAGE_MAINTENANCE_LOCK_DIR, { recursive: false });
    created = true;
    writeFileSync(ownerPath(USAGE_MAINTENANCE_LOCK_DIR), JSON.stringify(owner), "utf8");
  } catch {
    if (lockOwnedBy(USAGE_MAINTENANCE_LOCK_DIR, owner)) releaseOwnedLock(USAGE_MAINTENANCE_LOCK_DIR, owner);
    else if (created) rmSync(USAGE_MAINTENANCE_LOCK_DIR, { recursive: true, force: true });
    return undefined;
  }

  try {
    return fn();
  } finally {
    releaseOwnedLock(USAGE_MAINTENANCE_LOCK_DIR, owner);
  }
}
