import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentConfig, LaunchInput, Runner, SubagentRun, SubagentSnapshot } from "./types.ts";
import { snapshotRun } from "./snapshot.ts";
import { deleteRunSessionFile } from "./runner.ts";
import { settingValue } from "./settings.ts";
import { deleteManagedChildSession, deleteParentPersistence, gcOrphanedParents, readParentRuns, restoredRun, toPersistedRun, writeParentRuns } from "./persistence.ts";

const KEY = Symbol.for("pip-subagents.manager");

export interface ManagerOptions {
  runner: Runner;
  now?: () => number;
  inject?: (parentSessionKey: string, message: string) => void;
  persistenceDir?: string;
}

function id(): string {
  return `sa_${randomUUID().slice(0, 8)}`;
}

function canAccessParent(parentSessionFile: string): boolean {
  return existsSync(parentSessionFile);
}

function wrapSteerMessage(message: string): string {
  return [
    "<subagent_steering>",
    "This is a mid-run steering note from the parent session.",
    "Incorporate it if relevant, but keep completing the original delegated task unless this message explicitly says to abandon or replace that task.",
    "",
    message,
    "</subagent_steering>",
  ].join("\n");
}

export class SubagentManager {
  private shuttingDown = false;
  runs = new Map<string, SubagentRun>();
  aliases = new Map<string, string>();
  foreground = new Set<string>();
  pendingCompletions = new Map<string, string[]>();
  activeParentSessionKey: string | undefined;
  runner: Runner;
  now: () => number;
  inject?: (parentSessionKey: string, message: string) => void;
  persistenceDir?: string;
  loadedParents = new Set<string>();
  parentBranches = new Map<string, Set<string>>();

  constructor(options: ManagerOptions) {
    this.runner = options.runner;
    this.now = options.now ?? (() => Date.now());
    this.inject = options.inject;
    this.persistenceDir = options.persistenceDir;
  }

  configure(options: Partial<ManagerOptions>): void {
    if (options.runner) this.runner = options.runner;
    if (options.now) this.now = options.now;
    if (options.inject) this.inject = options.inject;
    if (options.persistenceDir) this.persistenceDir = options.persistenceDir;
  }

  setActiveParent(key: string, parentSessionFile?: string, branchIds?: string[]): void {
    this.activeParentSessionKey = key;
    if (branchIds) this.parentBranches.set(key, new Set(branchIds));
    gcOrphanedParents(parentSessionFile, this.persistenceDir);
    this.purgeLoadedParentIfDeleted(key, parentSessionFile);
    this.loadParent(key);
    this.cleanup(key);
    this.flushPending(key);
  }

  private aliasKey(parentSessionKey: string, name: string): string {
    return `${parentSessionKey}\0${name}`;
  }

  private purgeLoadedParentIfDeleted(parentSessionKey: string, parentSessionFile?: string): void {
    if (!this.loadedParents.has(parentSessionKey) || !parentSessionFile || canAccessParent(parentSessionFile)) return;
    for (const run of [...this.runs.values()].filter((item) => item.parentSessionKey === parentSessionKey)) {
      run.abortController.abort();
      try { void run.cancel?.(); } catch {}
      try { run.dispose?.(); } catch {}
      deleteManagedChildSession(parentSessionKey, run.sessionFile);
      this.runs.delete(run.id);
      this.foreground.delete(run.id);
      if (run.name) this.aliases.delete(this.aliasKey(parentSessionKey, run.name));
    }
    this.loadedParents.delete(parentSessionKey);
    deleteParentPersistence(parentSessionKey, this.persistenceDir);
  }

  private loadParent(parentSessionKey: string): void {
    if (this.loadedParents.has(parentSessionKey)) return;
    const loaded = readParentRuns(parentSessionKey, this.persistenceDir);
    this.loadedParents.add(parentSessionKey);
    if (!loaded) return;
    if (!canAccessParent(loaded.parentSessionFile)) {
      for (const record of loaded.runs) deleteManagedChildSession(parentSessionKey, record.sessionFile);
      deleteParentPersistence(parentSessionKey, this.persistenceDir);
      return;
    }
    for (const record of loaded.runs) {
      if (this.runs.has(record.id)) continue;
      const run = restoredRun(record, this.now());
      run.persist = () => this.saveRun(run);
      this.runs.set(run.id, run);
      if (run.name) this.aliases.set(this.aliasKey(run.parentSessionKey, run.name), run.id);
    }
    this.saveParent(parentSessionKey);
  }

  private saveParent(parentSessionKey: string): void {
    const persisted = [...this.runs.values()].filter((run) => run.parentSessionKey === parentSessionKey).map(toPersistedRun).filter((run): run is NonNullable<typeof run> => Boolean(run));
    const parentSessionFile = persisted[0]?.parentSessionFile;
    if (!parentSessionFile) {
      deleteParentPersistence(parentSessionKey, this.persistenceDir);
      return;
    }
    writeParentRuns(parentSessionKey, parentSessionFile, persisted, this.persistenceDir);
  }

  private saveRun(run: SubagentRun): void {
    this.saveParent(run.parentSessionKey);
  }

  private isVisible(run: SubagentRun, parentSessionKey?: string): boolean {
    if (parentSessionKey && run.parentSessionKey !== parentSessionKey) return false;
    const branch = this.parentBranches.get(run.parentSessionKey);
    if (!branch || !run.anchorEntryId) return true;
    return branch.has(run.anchorEntryId);
  }

  resolve(ref: string | undefined, parentSessionKey?: string): SubagentRun | undefined {
    if (!ref) return;
    const byId = this.runs.get(ref);
    if (byId && this.isVisible(byId, parentSessionKey)) return byId;
    if (!parentSessionKey) return undefined;
    const byAlias = this.runs.get(this.aliases.get(this.aliasKey(parentSessionKey, ref)) ?? "");
    return byAlias && this.isVisible(byAlias, parentSessionKey) ? byAlias : undefined;
  }

  snapshot(run: SubagentRun): SubagentSnapshot {
    return snapshotRun(run);
  }

  ensureNameAvailable(name: string | undefined, parentSessionKey?: string): void {
    if (!name) return;
    if (this.runs.has(name) || (parentSessionKey && this.aliases.has(this.aliasKey(parentSessionKey, name)))) throw new Error(`Subagent name already exists: ${name}`);
  }

  runningCount(): number {
    return [...this.runs.values()].filter((run) => run.status === "running").length;
  }

  launch(input: LaunchInput): SubagentRun {
    if (this.shuttingDown) throw new Error("Subagent manager is shutting down.");
    this.cleanup();
    const maxRunning = settingValue("maxRunning", 6);
    if (this.runningCount() >= maxRunning) throw new Error(`Maximum concurrent subagents reached (${maxRunning}).`);
    this.ensureNameAvailable(input.name, input.parentSessionKey);
    const run: SubagentRun = {
      id: id(),
      name: input.name,
      agent: input.agent.name,
      prompt: input.prompt,
      cwd: input.cwd,
      parentSessionKey: input.parentSessionKey,
      parentSessionFile: input.parentSessionFile,
      keep: input.keep,
      anchorEntryId: input.anchorEntryId,
      background: input.background,
      detached: input.background,
      status: "running",
      createdAt: this.now(),
      updatedAt: this.now(),
      events: [],
      abortController: new AbortController(),
      forwarding: true,
    };
    run.persist = () => this.saveRun(run);
    this.runs.set(run.id, run);
    if (run.name) this.aliases.set(this.aliasKey(run.parentSessionKey, run.name), run.id);
    if (!run.background) this.foreground.add(run.id);
    run.detachPromise = new Promise<void>((resolve) => { run.resolveDetach = resolve; });
    if (!run.background && input.signal) {
      const onAbort = () => {
        if (run.detached || run.background) return;
        void this.cancel(run).catch(() => undefined);
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      run.removeParentAbort = () => input.signal?.removeEventListener("abort", onAbort);
      if (input.signal.aborted) onAbort();
    }

    run.detach = () => {
      run.background = true;
      run.detached = true;
      run.forwarding = false;
      run.removeParentAbort?.();
      run.removeParentAbort = undefined;
      this.foreground.delete(run.id);
      run.resolveDetach?.();
    };

    this.saveRun(run);

    run.runPromise = this.runner.launch(input, run).catch((error) => {
      run.status = run.abortController.signal.aborted ? "cancelled" : "error";
      run.errorText = run.status === "cancelled" ? "Cancelled" : error instanceof Error ? error.message : String(error);
      run.completedAt = this.now();
      run.updatedAt = run.completedAt;
      return run;
    }).then((finished) => {
      if (this.shuttingDown || this.runs.get(finished.id) !== finished) return finished;
      this.foreground.delete(run.id);
      finished.removeParentAbort?.();
      finished.removeParentAbort = undefined;
      if (finished.background && finished.status !== "cancelled") this.completeBackground(finished);
      this.saveRun(finished);
      this.cleanup();
      return finished;
    });
    return run;
  }

  async continueRun(run: SubagentRun, prompt: string, agent?: AgentConfig): Promise<void> {
    if (!run.keep && run.status !== "interrupted") throw new Error(`Subagent ${run.id} is ephemeral and cannot be continued after completion. Launch a new subagent with full context, or use keep:true when creating a reusable run.`);
    if (run.status === "running") throw new Error(`Subagent ${run.id} is already running.`);
    if (!run.sessionFile) throw new Error(`Subagent ${run.id} cannot be continued because its child session file is missing.`);
    run.abortController = new AbortController();
    run.errorText = undefined;
    run.resultText = undefined;
    run.status = "running";
    run.background = false;
    run.detached = false;
    run.forwarding = true;
    this.foreground.add(run.id);
    try {
      if (run.continuePrompt) await run.continuePrompt(prompt);
      else {
        if (!agent) throw new Error(`Subagent ${run.id} cannot be continued until its agent definition is available.`);
        run.runPromise = this.runner.launch({ agent, prompt, cwd: run.cwd, parentSessionKey: run.parentSessionKey, parentSessionFile: run.parentSessionFile, anchorEntryId: run.anchorEntryId, name: run.name, keep: run.keep, background: false, resumeSessionFile: run.sessionFile }, run);
        await run.runPromise;
      }
      if (run.status === "running") run.status = "completed";
    } catch (error) {
      run.status = run.abortController.signal.aborted ? "cancelled" : "error";
      run.errorText = run.status === "cancelled" ? "Cancelled" : error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      run.completedAt = this.now();
      run.updatedAt = run.completedAt;
      this.foreground.delete(run.id);
      this.saveRun(run);
    }
  }

  async steer(run: SubagentRun, message: string): Promise<void> {
    if (run.status !== "running" && !run.keep) throw new Error(`Subagent ${run.id} is ephemeral and cannot be steered after completion.`);
    if (!run.steer) throw new Error(`Subagent ${run.id} cannot be steered.`);
    if (run.status !== "running") {
      run.abortController = new AbortController();
      run.errorText = undefined;
      run.resultText = undefined;
    }
    run.events.push({ type: "steer", text: message, at: this.now() });
    if (run.events.length > 300) run.events.splice(0, run.events.length - 300);
    await run.steer(wrapSteerMessage(message), message);
    this.saveRun(run);
  }

  async cancel(run: SubagentRun): Promise<void> {
    if (run.status !== "running") throw new Error(`Subagent ${run.id} is not running.`);
    run.abortController.abort();
    await run.cancel?.();
    run.status = "cancelled";
    run.errorText = "Cancelled";
    run.completedAt = this.now();
    run.updatedAt = run.completedAt;
    this.foreground.delete(run.id);
    this.saveRun(run);
  }

  detach(run: SubagentRun): void {
    if (run.status !== "running") throw new Error(`Subagent ${run.id} is not running.`);
    run.detach?.();
    this.saveRun(run);
  }

  detachAll(parentSessionKey?: string): SubagentRun[] {
    const runs = [...this.foreground]
      .map((id) => this.runs.get(id))
      .filter((run): run is SubagentRun => !!run)
      .filter((run) => !parentSessionKey || run.parentSessionKey === parentSessionKey);
    for (const run of runs) this.detach(run);
    return runs;
  }

  keep(run: SubagentRun): void {
    run.keep = true;
    if (run.name) this.aliases.set(this.aliasKey(run.parentSessionKey, run.name), run.id);
    this.saveRun(run);
  }

  forget(run: SubagentRun): void {
    if (!run.keep) return;
    run.keep = false;
    if (run.name) this.aliases.delete(this.aliasKey(run.parentSessionKey, run.name));
    this.saveParent(run.parentSessionKey);
  }

  delete(run: SubagentRun): void {
    if (run.status === "running") throw new Error(`Cannot delete running subagent ${run.id}; cancel or background it first.`);
    run.dispose?.();
    deleteManagedChildSession(run.parentSessionKey, run.sessionFile);
    if (!run.sessionFile) deleteRunSessionFile(run);
    this.runs.delete(run.id);
    if (run.name) this.aliases.delete(this.aliasKey(run.parentSessionKey, run.name));
    this.saveParent(run.parentSessionKey);
  }

  list(parentSessionKey?: string): SubagentRun[] {
    const runs = [...this.runs.values()].filter((run) => this.isVisible(run, parentSessionKey));
    return runs.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  completionMessage(run: SubagentRun): string {
    const title = run.status === "completed" ? "completed" : "failed";
    const body = run.status === "completed" ? `<subagent_result>\n${run.resultText ?? "(no output)"}\n</subagent_result>` : `Error: ${run.errorText ?? "unknown"}`;
    return [`**Background subagent ${title}: ${run.id}** (${run.agent}, ${((run.completedAt ?? this.now()) - run.createdAt) / 1000}s)`, `> ${run.prompt.slice(0, 160)}`, "", body].join("\n");
  }

  completeBackground(run: SubagentRun): void {
    if (!settingValue("injectBackgroundResults", true)) return;
    const message = this.completionMessage(run);
    if (this.activeParentSessionKey === run.parentSessionKey && this.inject) this.inject(run.parentSessionKey, message);
    else this.pendingCompletions.set(run.parentSessionKey, [...(this.pendingCompletions.get(run.parentSessionKey) ?? []), message]);
  }

  flushPending(parentSessionKey: string): void {
    const pending = this.pendingCompletions.get(parentSessionKey);
    if (!pending?.length || !this.inject) return;
    this.pendingCompletions.delete(parentSessionKey);
    for (const message of pending) this.inject(parentSessionKey, message);
  }

  cleanup(parentSessionKey?: string): void {
    const ttlMs = settingValue("ephemeralTtlMinutes", 30) * 60_000;
    const now = this.now();
    const candidates = [...this.runs.values()].filter((run) => !parentSessionKey || run.parentSessionKey === parentSessionKey);
    for (const run of candidates) {
      if (run.keep) continue;
      const branch = this.parentBranches.get(run.parentSessionKey);
      if (branch && run.anchorEntryId && !branch.has(run.anchorEntryId)) {
        this.pruneEphemeral(run);
        continue;
      }
      if (run.status !== "running" && run.completedAt && now - run.completedAt > ttlMs) this.pruneEphemeral(run);
    }
    const max = settingValue("maxRecentPerParent", 20);
    const groups = new Map<string, SubagentRun[]>();
    for (const run of this.runs.values()) {
      if (parentSessionKey && run.parentSessionKey !== parentSessionKey) continue;
      if (run.status !== "running" && !run.keep) groups.set(run.parentSessionKey, [...(groups.get(run.parentSessionKey) ?? []), run]);
    }
    for (const runs of groups.values()) {
      const extra = runs.sort((a, b) => b.updatedAt - a.updatedAt).slice(max);
      for (const run of extra) this.pruneEphemeral(run);
    }
  }

  private pruneEphemeral(run: SubagentRun): void {
    if (run.keep) return;
    if (run.status === "running") {
      run.abortController.abort();
      try { void run.cancel?.(); } catch {}
      run.status = "cancelled";
      run.errorText = "Pruned";
      run.completedAt = this.now();
      run.updatedAt = run.completedAt;
    }
    try { this.delete(run); } catch {}
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const run of [...this.runs.values()]) {
      if (run.status === "running") {
        run.abortController.abort();
        try { await run.cancel?.(); } catch {}
        run.status = "interrupted";
        run.errorText = "Subagent was interrupted by parent process shutdown/restart.";
        run.completedAt = this.now();
        run.updatedAt = run.completedAt;
      }
      this.saveRun(run);
      try { run.dispose?.(); } catch {}
    }
    this.runs.clear();
    this.aliases.clear();
    this.foreground.clear();
    this.pendingCompletions.clear();
  }
}

export function getManager(options: ManagerOptions): SubagentManager {
  const globalState = globalThis as any;
  const current = globalState[KEY];
  if (!current) globalState[KEY] = new SubagentManager(options);
  else current.configure(options);
  return globalState[KEY];
}

export async function shutdownGlobalManager(): Promise<void> {
  const globalState = globalThis as any;
  const current = globalState[KEY];
  delete globalState[KEY];
  if (current && typeof current.shutdown === "function") await current.shutdown();
}

export function resetManagerForTests(): void {
  const globalState = globalThis as any;
  delete globalState[KEY];
}
