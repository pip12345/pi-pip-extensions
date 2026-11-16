import { randomUUID } from "node:crypto";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { addUsage, emptyUsage, sessionUsageRecord, type TokenUsage } from "../../pip-common/index.ts";
import type { AgentConfig } from "./agents.ts";
import type { ChildSession, CreateChildSession } from "./child.ts";

export type RunStatus = "running" | "completed" | "error" | "cancelled";

/**
 * A subagent run lives in memory for one parent session. Its child AgentSession exists only while
 * the run is working: finishing disposes it, which also closes the child's MCP connections. The
 * in-memory SessionManager keeps the conversation, so a later message continues it in a new session.
 */
export interface SubagentRun {
  id: string;
  agent: AgentConfig;
  model?: string;
  /** The launch prompt. */
  task: string;
  cwd: string;
  projectTrusted: boolean;
  background: boolean;
  status: RunStatus;
  /** When the run was launched. */
  startedAt: number;
  /** When the latest turn began; equals startedAt until the run is continued. */
  turnStartedAt: number;
  completedAt?: number;
  resultText?: string;
  errorText?: string;
  /** Usage across all of the run's turns, including continuations. */
  usage: TokenUsage;
  toolCalls: number;
  sessionManager: SessionManager;
  session?: AgentSession;
  /** Transcript captured when the last session was disposed. */
  messages: any[];
  done: Promise<void>;
  cancelRequested: boolean;
}

/** Serializable view of a run for tool results. pi-stats reads `id` and the cumulative `usage`. */
export interface RunSnapshot {
  id: string;
  agent: string;
  model?: string;
  task: string;
  status: RunStatus;
  background: boolean;
  startedAt: number;
  turnStartedAt: number;
  completedAt?: number;
  toolCalls: number;
  usage: TokenUsage;
  resultText?: string;
  errorText?: string;
}

export interface LaunchOptions {
  agent: AgentConfig;
  prompt: string;
  cwd: string;
  projectTrusted: boolean;
  model?: string;
  background: boolean;
  signal?: AbortSignal;
  onUpdate?: (run: SubagentRun) => void;
}

export interface SubagentRunsOptions {
  createChild: CreateChildSession;
  maxRunning: () => number;
  /** Called when a background run finishes; foreground callers read the result themselves. */
  onBackgroundDone: (run: SubagentRun) => void;
  now?: () => number;
}

function steeringNote(message: string): string {
  return [
    "<subagent_steering>",
    "This is a mid-run note from the parent session. Keep completing the original task unless this note explicitly replaces it.",
    "",
    message,
    "</subagent_steering>",
  ].join("\n");
}

function lastAssistant(messages: any[]): any {
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index]?.role === "assistant") return messages[index];
  return undefined;
}

export function snapshot(run: SubagentRun): RunSnapshot {
  return {
    id: run.id,
    agent: run.agent.name,
    model: run.model,
    task: run.task,
    status: run.status,
    background: run.background,
    startedAt: run.startedAt,
    turnStartedAt: run.turnStartedAt,
    completedAt: run.completedAt,
    toolCalls: run.toolCalls,
    usage: { ...run.usage },
    resultText: run.resultText,
    errorText: run.errorText,
  };
}

/** Live transcript while the child session exists, otherwise the captured one. */
export function runMessages(run: SubagentRun): any[] {
  if (!run.session) return run.messages;
  const streaming = run.session.state.streamingMessage;
  return streaming ? [...run.session.messages, streaming] : run.session.messages;
}

export class SubagentRuns {
  private readonly runs = new Map<string, SubagentRun>();
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly options: SubagentRunsOptions) {
    this.now = options.now ?? Date.now;
  }

  list(): SubagentRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): SubagentRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Subagent not found: ${id}. Known ids: ${[...this.runs.keys()].join(", ") || "none"}.`);
    return run;
  }

  launch(options: LaunchOptions): SubagentRun {
    const run: SubagentRun = {
      id: `sa_${randomUUID().slice(0, 8)}`,
      agent: options.agent,
      model: options.model ?? options.agent.model,
      task: options.prompt,
      cwd: options.cwd,
      projectTrusted: options.projectTrusted,
      background: options.background,
      status: "running",
      startedAt: this.now(),
      turnStartedAt: this.now(),
      usage: emptyUsage(),
      toolCalls: 0,
      sessionManager: SessionManager.inMemory(options.cwd),
      messages: [],
      done: Promise.resolve(),
      cancelRequested: false,
    };
    this.start(run, options.prompt, options);
    this.runs.set(run.id, run);
    return run;
  }

  /**
   * Steers a working run, or continues a finished one with a new turn. A foreground continuation
   * resolves when the turn finishes; a background one reports through onBackgroundDone.
   */
  async message(run: SubagentRun, message: string, options: { background?: boolean; signal?: AbortSignal; onUpdate?: (run: SubagentRun) => void } = {}): Promise<"steered" | "continued"> {
    if (run.status === "running") {
      if (!run.session?.isStreaming) throw new Error(`Subagent ${run.id} is starting or finishing a turn; try again shortly.`);
      await run.session.steer(steeringNote(message));
      return "steered";
    }
    const background = options.background ?? false;
    this.start(run, message, { ...options, background });
    if (!background) await run.done;
    return "continued";
  }

  async cancel(run: SubagentRun): Promise<void> {
    if (run.status !== "running") throw new Error(`Subagent ${run.id} is not running.`);
    run.cancelRequested = true;
    await run.session?.abort();
    await run.done;
  }

  /** Stops every run without reporting results. The parent session is going away. */
  async close(): Promise<void> {
    this.closed = true;
    const running = this.list().filter((run) => run.status === "running");
    for (const run of running) run.cancelRequested = true;
    await Promise.allSettled(running.map(async (run) => {
      await run.session?.abort();
      await run.done;
    }));
    this.runs.clear();
  }

  private start(run: SubagentRun, prompt: string, options: { background: boolean; signal?: AbortSignal; onUpdate?: (run: SubagentRun) => void }): void {
    if (this.closed) throw new Error("Subagents are shutting down.");
    const running = this.list().filter((candidate) => candidate !== run && candidate.status === "running").length;
    const maxRunning = this.options.maxRunning();
    if (running >= maxRunning) throw new Error(`Maximum concurrent subagents reached (${maxRunning}).`);
    run.status = "running";
    run.background = options.background;
    run.cancelRequested = false;
    run.resultText = undefined;
    run.errorText = undefined;
    run.completedAt = undefined;
    run.turnStartedAt = this.now();
    run.done = this.execute(run, prompt, options);
  }

  private async execute(run: SubagentRun, prompt: string, options: { background: boolean; signal?: AbortSignal; onUpdate?: (run: SubagentRun) => void }): Promise<void> {
    // A foreground run belongs to the parent tool call, so aborting that call cancels it.
    const onParentAbort = () => { run.cancelRequested = true; void run.session?.abort(); };
    options.signal?.addEventListener("abort", onParentAbort, { once: true });
    if (options.signal?.aborted) run.cancelRequested = true;
    let child: ChildSession | undefined;
    // The outcome is applied only after the child session is closed, so the run counts as running
    // until then and no new turn can start on it while the old session shuts down.
    let outcome: Pick<SubagentRun, "status" | "resultText" | "errorText">;
    try {
      if (run.cancelRequested) throw new Error("Cancelled");
      child = await this.options.createChild({ cwd: run.cwd, agent: run.agent, model: run.model, projectTrusted: run.projectTrusted, sessionManager: run.sessionManager });
      const session = child.session;
      run.session = session;
      if (run.cancelRequested) throw new Error("Cancelled");
      const unsubscribe = session.subscribe((event: any) => {
        const billed = event.type === "message_end"
          ? sessionUsageRecord({ type: "message", message: event.message })
          : event.type === "entry_appended" && event.entry?.type !== "message" ? sessionUsageRecord(event.entry) : undefined;
        if (billed) addUsage(run.usage, billed.usage);
        if (event.type === "tool_execution_start") run.toolCalls += 1;
        if (event.type === "message_end" || event.type === "tool_execution_start" || event.type === "tool_execution_end") options.onUpdate?.(run);
      });
      try {
        // Child prompts are task text, never commands or prompt templates.
        await session.prompt(prompt, { expandPromptTemplates: false });
      } finally {
        unsubscribe();
      }
      const last = lastAssistant(session.messages);
      if (run.cancelRequested) outcome = { status: "cancelled", errorText: "Cancelled" };
      else if (last?.stopReason === "error" || last?.stopReason === "aborted") outcome = { status: "error", errorText: last.errorMessage ?? session.state.errorMessage ?? `Child run ended with ${last.stopReason}.` };
      else outcome = { status: "completed", resultText: session.getLastAssistantText() ?? "" };
    } catch (error) {
      outcome = run.cancelRequested ? { status: "cancelled", errorText: "Cancelled" } : { status: "error", errorText: error instanceof Error ? error.message : String(error) };
    } finally {
      options.signal?.removeEventListener("abort", onParentAbort);
      if (child) {
        run.messages = [...child.session.messages];
        await child.close().catch(() => undefined);
      }
      run.session = undefined;
    }
    Object.assign(run, outcome, { completedAt: this.now() });
    options.onUpdate?.(run);
    if (run.background && run.status !== "cancelled" && !this.closed) this.options.onBackgroundDone(run);
  }
}
