import { randomUUID } from "node:crypto";
import type { LaunchInput, Runner, SubagentRun, SubagentSnapshot } from "./types.ts";
import { snapshotRun } from "./snapshot.ts";
import { deleteRunSessionFile } from "./runner.ts";
import { settingValue } from "./settings.ts";

const KEY = Symbol.for("pip-subagents.manager");

export interface ManagerOptions {
  runner: Runner;
  now?: () => number;
  inject?: (parentSessionKey: string, message: string) => void;
}

function id(): string {
  return `sa_${randomUUID().slice(0, 8)}`;
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

  constructor(options: ManagerOptions) {
    this.runner = options.runner;
    this.now = options.now ?? (() => Date.now());
    this.inject = options.inject;
  }

  configure(options: Partial<ManagerOptions>): void {
    if (options.runner) this.runner = options.runner;
    if (options.now) this.now = options.now;
    if (options.inject) this.inject = options.inject;
  }

  setActiveParent(key: string): void {
    this.activeParentSessionKey = key;
    this.flushPending(key);
  }

  resolve(ref: string | undefined): SubagentRun | undefined {
    if (!ref) return;
    return this.runs.get(ref) ?? this.runs.get(this.aliases.get(ref) ?? "");
  }

  snapshot(run: SubagentRun): SubagentSnapshot {
    return snapshotRun(run);
  }

  ensureNameAvailable(name: string | undefined): void {
    if (!name) return;
    if (this.aliases.has(name) || this.runs.has(name)) throw new Error(`Subagent name already exists: ${name}`);
  }

  runningCount(): number {
    return [...this.runs.values()].filter((run) => run.status === "running").length;
  }

  launch(input: LaunchInput): SubagentRun {
    if (this.shuttingDown) throw new Error("Subagent manager is shutting down.");
    this.cleanup();
    const maxRunning = settingValue("maxRunning", 6);
    if (this.runningCount() >= maxRunning) throw new Error(`Maximum concurrent subagents reached (${maxRunning}).`);
    this.ensureNameAvailable(input.name);
    const run: SubagentRun = {
      id: id(),
      name: input.name,
      agent: input.agent.name,
      prompt: input.prompt,
      cwd: input.cwd,
      parentSessionKey: input.parentSessionKey,
      parentSessionFile: input.parentSessionFile,
      keep: input.keep,
      background: input.background,
      detached: input.background,
      status: "running",
      createdAt: this.now(),
      updatedAt: this.now(),
      events: [],
      abortController: new AbortController(),
      forwarding: true,
    };
    this.runs.set(run.id, run);
    if (run.name) this.aliases.set(run.name, run.id);
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
      this.cleanup();
      return finished;
    });
    return run;
  }

  async continueRun(run: SubagentRun, prompt: string): Promise<void> {
    if (!run.keep) throw new Error(`Subagent ${run.id} is ephemeral and cannot be continued. Launch a new subagent with full context, or use keep:true when creating a reusable run.`);
    if (run.status === "running") throw new Error(`Subagent ${run.id} is already running.`);
    run.abortController = new AbortController();
    run.errorText = undefined;
    run.resultText = undefined;
    run.status = "running";
    run.background = false;
    run.detached = false;
    run.forwarding = true;
    this.foreground.add(run.id);
    try {
      await run.continuePrompt?.(prompt);
      if (run.status === "running") run.status = "completed";
    } catch (error) {
      run.status = run.abortController.signal.aborted ? "cancelled" : "error";
      run.errorText = run.status === "cancelled" ? "Cancelled" : error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      run.completedAt = this.now();
      run.updatedAt = run.completedAt;
      this.foreground.delete(run.id);
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
  }

  detach(run: SubagentRun): void {
    if (run.status !== "running") throw new Error(`Subagent ${run.id} is not running.`);
    run.detach?.();
  }

  detachAll(): SubagentRun[] {
    const runs = [...this.foreground].map((id) => this.runs.get(id)).filter((run): run is SubagentRun => Boolean(run));
    for (const run of runs) this.detach(run);
    return runs;
  }

  keep(run: SubagentRun): void {
    run.keep = true;
  }

  forget(run: SubagentRun): void {
    if (run.status === "running") throw new Error(`Cannot forget running subagent ${run.id}; cancel or background it first.`);
    run.dispose?.();
    deleteRunSessionFile(run);
    this.runs.delete(run.id);
    if (run.name) this.aliases.delete(run.name);
  }

  list(parentSessionKey?: string): SubagentRun[] {
    const runs = [...this.runs.values()].filter((run) => !parentSessionKey || run.parentSessionKey === parentSessionKey);
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

  cleanup(): void {
    const ttlMs = settingValue("ephemeralTtlMinutes", 30) * 60_000;
    const now = this.now();
    for (const run of [...this.runs.values()]) {
      if (run.status === "running" || run.keep || !run.completedAt) continue;
      if (now - run.completedAt > ttlMs) this.forgetCompleted(run);
    }
    const max = settingValue("maxRecentPerParent", 20);
    const groups = new Map<string, SubagentRun[]>();
    for (const run of this.runs.values()) if (run.status !== "running" && !run.keep) groups.set(run.parentSessionKey, [...(groups.get(run.parentSessionKey) ?? []), run]);
    for (const runs of groups.values()) {
      const extra = runs.sort((a, b) => b.updatedAt - a.updatedAt).slice(max);
      for (const run of extra) this.forgetCompleted(run);
    }
  }

  private forgetCompleted(run: SubagentRun): void {
    if (run.status === "running") return;
    try { this.forget(run); } catch {}
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const run of [...this.runs.values()]) {
      if (run.status === "running") {
        run.abortController.abort();
        try { await run.cancel?.(); } catch {}
      }
      try { run.dispose?.(); } catch {}
      try { deleteRunSessionFile(run); } catch {}
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
