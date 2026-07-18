import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { emptyUsage, type ScopedSettings } from "../../pip-common/index.ts";
import type { AgentConfig, LaunchInput, Runner, SubagentRun, SubagentSnapshot } from "./types.ts";
import { snapshotRun } from "./snapshot.ts";
import { deleteRunSessionFile } from "./runner.ts";
import { appendWorkspaceGuidance, contextRoot, runContextDir } from "./context.ts";
import { deleteManagedChildSession, deleteParentPersistence, gcOrphanedParents, readParentRuns, restoredRun, toPersistedRun, writeParentRuns } from "./persistence.ts";
import { boundSubagentResult, boundSubagentText, MAX_SUBAGENT_COMPLETION_CHARS, MAX_SUBAGENT_ERROR_CHARS, MAX_SUBAGENT_EVENT_TEXT_CHARS, MAX_SUBAGENT_EVENTS } from "./bounds.ts";

export interface ManagerOptions {
  runner: Runner;
  now?: () => number;
  inject?: (parentSessionKey: string, message: string) => void;
  persistenceDir?: string;
  contextDir?: string;
  settings?: ScopedSettings;
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
  private pendingPersistence = new Map<string, ReturnType<typeof setTimeout>>();
  runs = new Map<string, SubagentRun>();
  aliases = new Map<string, string>();
  foreground = new Set<string>();
  pendingCompletions = new Map<string, string[]>();
  activeParentSessionKey: string | undefined;
  runner: Runner;
  now: () => number;
  inject?: (parentSessionKey: string, message: string) => void;
  persistenceDir?: string;
  contextDir?: string;
  loadedParents = new Set<string>();
  parentBranches = new Map<string, Set<string>>();
  private settings: ScopedSettings;

  constructor(options: ManagerOptions) {
    this.runner = options.runner;
    this.now = options.now ?? (() => Date.now());
    this.inject = options.inject;
    this.persistenceDir = options.persistenceDir;
    this.contextDir = options.contextDir;
    this.settings = options.settings ?? { id: "subagents-defaults", path: (key) => key, get: (_key, fallback) => fallback, onChange: () => () => undefined };
  }

  configure(options: Partial<ManagerOptions>): void {
    if (options.runner) this.runner = options.runner;
    if (options.now) this.now = options.now;
    if (options.inject) this.inject = options.inject;
    if (options.persistenceDir) this.persistenceDir = options.persistenceDir;
    if (options.contextDir) this.contextDir = options.contextDir;
    if (options.settings) this.settings = options.settings;
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

  deactivateParent(key?: string): void {
    if (key && this.activeParentSessionKey !== key) return;
    this.activeParentSessionKey = undefined;
    this.inject = undefined;
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
      this.deleteRunContext(run);
      this.runs.delete(run.id);
      this.foreground.delete(run.id);
      if (run.name) this.aliases.delete(this.aliasKey(parentSessionKey, run.name));
    }
    this.loadedParents.delete(parentSessionKey);
    rmSync(contextRoot(parentSessionKey, this.contextDir), { recursive: true, force: true });
    deleteParentPersistence(parentSessionKey, this.persistenceDir);
  }

  private loadParent(parentSessionKey: string): void {
    if (this.loadedParents.has(parentSessionKey)) return;
    const loaded = readParentRuns(parentSessionKey, this.persistenceDir);
    this.loadedParents.add(parentSessionKey);
    if (!loaded) return;
    if (!canAccessParent(loaded.parentSessionFile)) {
      for (const record of loaded.runs) deleteManagedChildSession(parentSessionKey, record.sessionFile);
      rmSync(contextRoot(parentSessionKey, this.contextDir), { recursive: true, force: true });
      deleteParentPersistence(parentSessionKey, this.persistenceDir);
      return;
    }
    for (const record of loaded.runs) {
      if (this.runs.has(record.id)) continue;
      const run = restoredRun(record, this.now());
      run.contextRoot = contextRoot(parentSessionKey, this.contextDir);
      run.runContextDir = runContextDir(parentSessionKey, run.id, this.contextDir);
      run.persist = () => this.scheduleSaveRun(run);
      this.runs.set(run.id, run);
      if (run.name) this.aliases.set(this.aliasKey(run.parentSessionKey, run.name), run.id);
    }
    this.saveParent(parentSessionKey);
  }

  private saveParent(parentSessionKey: string): void {
    const pending = this.pendingPersistence.get(parentSessionKey);
    if (pending) clearTimeout(pending);
    this.pendingPersistence.delete(parentSessionKey);
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

  private scheduleSaveRun(run: SubagentRun): void {
    const parentSessionKey = run.parentSessionKey;
    if (this.pendingPersistence.has(parentSessionKey)) return;
    const timer = setTimeout(() => {
      this.pendingPersistence.delete(parentSessionKey);
      this.saveParent(parentSessionKey);
    }, 250);
    timer.unref?.();
    this.pendingPersistence.set(parentSessionKey, timer);
  }

  private touchRun(run: SubagentRun, at = this.now()): void {
    run.updatedAt = at;
    this.saveRun(run);
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

  contextRootFor(parentSessionKey: string): string {
    return contextRoot(parentSessionKey, this.contextDir);
  }

  ensureNameAvailable(name: string | undefined, parentSessionKey?: string): void {
    if (!name) return;
    if (this.runs.has(name) || (parentSessionKey && this.aliases.has(this.aliasKey(parentSessionKey, name)))) throw new Error(`Subagent name already exists: ${name}`);
  }

  runningCount(): number {
    return [...this.runs.values()].filter((run) => run.status === "running").length;
  }

  private assertCanStartGeneration(run?: SubagentRun): void {
    if (this.shuttingDown) throw new Error("Subagent manager is shutting down.");
    const maxRunning = this.settings.get("maxRunning", 6);
    const running = [...this.runs.values()].filter((candidate) => candidate !== run && candidate.status === "running").length;
    if (running >= maxRunning) throw new Error(`Maximum concurrent subagents reached (${maxRunning}).`);
  }

  private startGeneration(
    run: SubagentRun,
    options: { prompt: string; displayPrompt?: string; background: boolean; signal?: AbortSignal },
    execute: () => Promise<unknown>,
  ): Promise<SubagentRun> {
    this.assertCanStartGeneration(run);
    run.generation = (run.generation ?? 0) + 1;
    const generation = run.generation;
    run.removeParentAbort?.();
    run.abortController = new AbortController();
    run.errorText = undefined;
    run.resultText = undefined;
    run.completedAt = undefined;
    run.status = "running";
    run.background = options.background;
    run.detached = options.background;
    run.forwarding = !options.background;
    if (options.background) this.foreground.delete(run.id);
    else this.foreground.add(run.id);

    run.detachPromise = new Promise<void>((resolve) => { run.resolveDetach = resolve; });
    run.detach = () => {
      run.background = true;
      run.detached = true;
      run.forwarding = false;
      run.removeParentAbort?.();
      run.removeParentAbort = undefined;
      this.foreground.delete(run.id);
      run.resolveDetach?.();
    };

    if (!options.background && options.signal) {
      const onAbort = () => {
        if (run.detached || run.background || run.generation !== generation) return;
        void this.cancel(run).catch(() => undefined);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      run.removeParentAbort = () => options.signal?.removeEventListener("abort", onAbort);
      if (options.signal.aborted) onAbort();
    }

    run.prompt = options.displayPrompt ?? options.prompt;
    this.touchRun(run);
    const promise = Promise.resolve()
      .then(async () => {
        if (run.abortController.signal.aborted) throw new Error("Cancelled");
        await execute();
        return run;
      })
      .catch((error) => {
        if (run.generation !== generation) return run;
        run.status = run.abortController.signal.aborted ? "cancelled" : "error";
        run.errorText = run.status === "cancelled" ? "Cancelled" : boundSubagentText(error instanceof Error ? error.message : String(error), MAX_SUBAGENT_ERROR_CHARS, 40);
        return run;
      })
      .then((finished) => {
        if (run.generation !== generation) return finished;
        run.removeParentAbort?.();
        run.removeParentAbort = undefined;
        this.foreground.delete(run.id);
        if (this.shuttingDown || this.runs.get(run.id) !== run) return finished;
        if (run.status === "running") run.status = run.abortController.signal.aborted ? "cancelled" : "completed";
        if (run.resultText) run.resultText = boundSubagentResult(run.resultText, run.sessionFile);
        if (run.errorText) run.errorText = boundSubagentText(run.errorText, MAX_SUBAGENT_ERROR_CHARS, 40);
        run.events = snapshotRun(run).events;
        run.completedAt = this.now();
        run.updatedAt = run.completedAt;
        run.prompt = options.displayPrompt ?? options.prompt;
        if (run.background && run.status !== "cancelled") this.completeBackground(run);
        this.saveRun(run);
        this.cleanup();
        return finished;
      });
    run.runPromise = promise;
    return promise;
  }

  launch(input: LaunchInput): SubagentRun {
    this.cleanup();
    this.assertCanStartGeneration();
    this.ensureNameAvailable(input.name, input.parentSessionKey);
    const runId = id();
    const root = contextRoot(input.parentSessionKey, this.contextDir);
    const runDir = runContextDir(input.parentSessionKey, runId, this.contextDir);
    const run: SubagentRun = {
      id: runId,
      name: input.name,
      agent: input.agent.name,
      model: input.model ?? input.agent.model,
      prompt: input.prompt,
      cwd: input.cwd,
      parentSessionKey: input.parentSessionKey,
      parentSessionFile: input.parentSessionFile,
      keep: input.keep,
      anchorEntryId: input.anchorEntryId,
      background: input.background,
      detached: input.background,
      status: "completed",
      createdAt: this.now(),
      updatedAt: this.now(),
      contextRoot: root,
      runContextDir: runDir,
      usage: emptyUsage(),
      events: [],
      abortController: new AbortController(),
      forwarding: !input.background,
    };
    run.persist = () => this.scheduleSaveRun(run);
    this.runs.set(run.id, run);
    if (run.name) this.aliases.set(this.aliasKey(run.parentSessionKey, run.name), run.id);

    const launchInput = { ...input, prompt: appendWorkspaceGuidance(input.prompt, root, runDir), contextRoot: root, runContextDir: runDir };
    try {
      this.startGeneration(run, { prompt: input.prompt, background: input.background, signal: input.signal }, () => this.runner.launch(launchInput, run));
    } catch (error) {
      this.runs.delete(run.id);
      if (run.name) this.aliases.delete(this.aliasKey(run.parentSessionKey, run.name));
      throw error;
    }
    return run;
  }

  async continueRun(run: SubagentRun, prompt: string, agent?: AgentConfig, signal?: AbortSignal, displayPrompt = prompt): Promise<void> {
    if (run.status === "running") throw new Error(`Subagent ${run.id} is already running.`);
    if (!run.sessionFile) throw new Error(`Subagent ${run.id} cannot be continued because its child session file is missing.`);
    const root = run.contextRoot ?? contextRoot(run.parentSessionKey, this.contextDir);
    const runDir = run.runContextDir ?? runContextDir(run.parentSessionKey, run.id, this.contextDir);
    run.contextRoot = root;
    run.runContextDir = runDir;
    const promptWithWorkspace = appendWorkspaceGuidance(prompt, root, runDir);
    const generation = this.startGeneration(run, { prompt, displayPrompt, background: false, signal }, async () => {
      if (run.continuePrompt) await run.continuePrompt(promptWithWorkspace);
      else {
        if (!agent) throw new Error(`Subagent ${run.id} cannot be continued until its agent definition is available.`);
        run.model ??= agent.model;
        await this.runner.launch({ agent, prompt: promptWithWorkspace, cwd: run.cwd, parentSessionKey: run.parentSessionKey, parentSessionFile: run.parentSessionFile, anchorEntryId: run.anchorEntryId, name: run.name, keep: run.keep, background: false, model: run.model, resumeSessionFile: run.sessionFile, contextRoot: root, runContextDir: runDir, signal }, run);
      }
    });
    await generation;
    if (run.status === "error") throw new Error(run.errorText ?? `Subagent ${run.id} failed.`);
    if (run.status === "cancelled") throw new Error(`Subagent ${run.id} was cancelled.`);
  }

  async steer(run: SubagentRun, message: string, agent?: AgentConfig, signal?: AbortSignal): Promise<void> {
    const steeringPrompt = wrapSteerMessage(message);
    const at = this.now();
    run.events.push({ type: "steer", text: boundSubagentText(message, MAX_SUBAGENT_EVENT_TEXT_CHARS, 40), at });
    if (run.events.length > MAX_SUBAGENT_EVENTS) run.events.splice(0, run.events.length - MAX_SUBAGENT_EVENTS);
    this.touchRun(run, at);

    if (run.status !== "running") {
      await this.continueRun(run, steeringPrompt, agent, signal, message);
      return;
    }
    if (!run.steer) throw new Error(`Subagent ${run.id} cannot be steered.`);
    await run.steer(steeringPrompt, message);
    this.touchRun(run);
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
    this.deleteRunContext(run);
    this.runs.delete(run.id);
    if (run.name) this.aliases.delete(this.aliasKey(run.parentSessionKey, run.name));
    this.saveParent(run.parentSessionKey);
  }

  private deleteRunContext(run: SubagentRun): void {
    rmSync(runContextDir(run.parentSessionKey, run.id, this.contextDir), { recursive: true, force: true });
  }

  list(parentSessionKey?: string): SubagentRun[] {
    const runs = [...this.runs.values()].filter((run) => this.isVisible(run, parentSessionKey));
    return runs.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  completionMessage(run: SubagentRun): string {
    const title = run.status === "completed" ? "completed" : "failed";
    const body = run.status === "completed"
      ? `<subagent_result>\n${boundSubagentResult(run.resultText ?? "(no output)", run.sessionFile, MAX_SUBAGENT_COMPLETION_CHARS - 1000)}\n</subagent_result>`
      : `Error: ${boundSubagentText(run.errorText ?? "unknown", MAX_SUBAGENT_ERROR_CHARS, 40)}`;
    return boundSubagentText([`**Background subagent ${title}: ${run.id}** (${[run.agent, run.model, `${((run.completedAt ?? this.now()) - run.createdAt) / 1000}s`].filter(Boolean).join(", ")})`, `> ${run.prompt.slice(0, 160)}`, "", body].join("\n"), MAX_SUBAGENT_COMPLETION_CHARS, 220);
  }

  completeBackground(run: SubagentRun): void {
    if (!this.settings.get("injectBackgroundResults", true)) return;
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
    const ttlMs = this.settings.get("ephemeralTtlMinutes", 30) * 60_000;
    const now = this.now();
    const candidates = [...this.runs.values()].filter((run) => !parentSessionKey || run.parentSessionKey === parentSessionKey);
    for (const run of candidates) {
      if (run.keep) continue;
      const branch = this.parentBranches.get(run.parentSessionKey);
      if (branch && run.anchorEntryId && !branch.has(run.anchorEntryId)) {
        this.pruneEphemeral(run);
        continue;
      }
      if (run.status !== "running" && now - run.updatedAt > ttlMs) this.pruneEphemeral(run);
    }
    const max = 20;
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
    for (const timer of this.pendingPersistence.values()) clearTimeout(timer);
    this.pendingPersistence.clear();
  }
}
