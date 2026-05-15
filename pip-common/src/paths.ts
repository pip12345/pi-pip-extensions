import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function pipDir(): string {
  return join(homedir(), ".pi", "agent", "pip");
}

export function pipPath(...parts: string[]): string {
  return join(pipDir(), ...parts);
}

export function ensurePipDir(): string {
  const dir = pipDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensurePipSubdir(...parts: string[]): string {
  const dir = pipPath(...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}
