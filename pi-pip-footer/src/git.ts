import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import { pipSettings } from "pip-common";
import { FOOTER_SETTINGS_ID } from "./constants.ts";

export interface GitState {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

export function parseGitStatus(output: string): GitState {
  let branch: string | null = null;
  let dirty = false;
  let ahead = 0;
  let behind = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length).trim();
    else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) {
        ahead = Number(match[1]) || 0;
        behind = Number(match[2]) || 0;
      }
    } else if (line && !line.startsWith("# ")) dirty = true;
  }
  if (branch === "(detached)") branch = null;
  return { branch, dirty, ahead, behind };
}

export function readGitState(cwd: string): GitState | null {
  try {
    return parseGitStatus(execSync("git status --porcelain=v2 --branch 2>/dev/null", { cwd, encoding: "utf8", timeout: 1000 }).trimEnd());
  } catch {
    return null;
  }
}

export function renderLocation(ctx: any, theme: any, gitState: GitState | null): string {
  const cwdSetting = pipSettings.get<"off" | "project" | "path">(`${FOOTER_SETTINGS_ID}.showCwd`);
  const parts: string[] = [];
  if (cwdSetting !== "off") {
    const home = homedir();
    const cwd = cwdSetting === "project" ? basename(ctx.cwd) : String(ctx.cwd).startsWith(home) ? `~${String(ctx.cwd).slice(home.length)}` : ctx.cwd;
    parts.push(theme.fg("accent", cwd));
  }
  if (pipSettings.get<boolean>(`${FOOTER_SETTINGS_ID}.showGit`) && gitState?.branch) {
    let branch = theme.fg(gitState.dirty ? "warning" : "success", gitState.branch);
    if (gitState.dirty) branch += theme.fg("warning", " *");
    if (gitState.ahead) branch += theme.fg("success", ` ↑${gitState.ahead}`);
    if (gitState.behind) branch += theme.fg("error", ` ↓${gitState.behind}`);
    parts.push(branch);
  }
  return parts.join("   ");
}
