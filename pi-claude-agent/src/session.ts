import type { AccountInfo, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { bounded, loggedIn, verifyVersion, type AgentSDK } from "./sdk.ts";
import { ToolBridge } from "./bridge.ts";
import type { InputContent } from "./history.ts";

interface Turn {
  messages: SDKMessage[];
  wake?: () => void;
  finished: boolean;
  drained: Promise<void>;
  drain: () => void;
}

export class ClaudeSession {
  private readonly query: Query;
  private readonly input: ReadableStreamDefaultController<SDKUserMessage>;
  private readonly pump: Promise<void>;
  private turn?: Turn;
  private failure?: unknown;
  private ended = false;
  private stopping?: Promise<void>;
  private info?: AccountInfo;
  get account(): AccountInfo | undefined { return this.info; }
  readonly ready: Promise<void>;

  constructor(sdk: AgentSDK, options: Options, readonly bridge: ToolBridge) {
    let input!: ReadableStreamDefaultController<SDKUserMessage>;
    const prompt = new ReadableStream<SDKUserMessage>({ start(controller) { input = controller; } });
    this.input = input;
    this.query = sdk.query({ prompt, options });
    this.ready = this.query.initializationResult().then((init) => {
      verifyVersion(init.claude_code_version);
      if (!loggedIn(init.account)) throw new Error("Claude Code is not logged in. Run `claude auth login` on this machine.");
      this.info = init.account;
    });
    this.ready.catch(() => {});
    // Exactly one iterator reader must remain alive during cancellation and parked tool calls.
    // Otherwise an interrupt can finish before the CLI flushes its final result.
    this.pump = this.readAll();
  }

  private async readAll(): Promise<void> {
    try {
      for await (const message of this.query) {
        const turn = this.turn;
        if (!turn) continue;
        turn.messages.push(message);
        if (message.type === "result") { turn.finished = true; turn.drain(); }
        turn.wake?.();
      }
    } catch (error) {
      this.failure = error;
    } finally {
      this.ended = true;
      this.turn?.drain();
      this.turn?.wake?.();
    }
  }

  begin(content: InputContent): void {
    if (this.ended || this.stopping) throw this.failure ?? new Error("Claude Code session has stopped.");
    if (this.turn && !this.turn.finished) throw new Error("Claude Code is still finishing the previous turn.");
    let drain!: () => void;
    const drained = new Promise<void>((done) => { drain = done; });
    this.turn = { messages: [], finished: false, drained, drain };
    this.send(content);
  }

  private send(content: InputContent, priority?: "next"): void {
    this.input.enqueue({ type: "user", uuid: randomUUID(), message: { role: "user", content }, parent_tool_use_id: null, ...(priority ? { priority } : {}) });
  }

  continue(results: ToolResultMessage[], content?: InputContent): void {
    if (!this.turn || this.turn.finished || this.ended) throw new Error("Claude's pending tool turn is no longer running.");
    // Queue steering before releasing results, so Claude cannot start inference without the new input.
    if (content?.length) this.send(content, "next");
    for (const result of results) this.bridge.resolve(result);
  }

  private async next(signal?: AbortSignal): Promise<SDKMessage> {
    const turn = this.turn;
    if (!turn) throw new Error("No active Claude turn.");
    while (true) {
      signal?.throwIfAborted();
      const message = turn.messages.shift();
      if (message) return message;
      if (this.ended) throw this.failure ?? new Error("Claude Code stopped before finishing its reply.");
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { turn.wake = undefined; reject(signal?.reason ?? new Error("Aborted")); };
        turn.wake = () => { signal?.removeEventListener("abort", cancel); turn.wake = undefined; resolve(); };
        signal?.addEventListener("abort", cancel, { once: true });
      });
    }
  }

  async readStep(emit: (message: SDKMessage) => Promise<boolean>, signal?: AbortSignal): Promise<"tools" | "stop"> {
    let calledTools = false;
    while (true) {
      const message = await this.next(signal);
      if (message.type === "system" && message.subtype === "init" && this.bridge.tools.length
        && !message.mcp_servers.some((server) => server.name === "pi" && server.status === "connected")) {
        throw new Error("Pi's tool server did not connect to Claude Code. Refusing to run without Pi's tools.");
      }
      calledTools = (await emit(message)) || calledTools;
      if (message.type === "stream_event" && message.parent_tool_use_id === null && message.event.type === "message_stop" && calledTools) return "tools";
      if (message.type === "result") return "stop";
    }
  }

  stop(): Promise<void> {
    if (!this.stopping) this.stopping = this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    try {
      if (this.turn && !this.turn.finished && !this.ended) {
        await bounded(this.query.interrupt(), undefined, 5_000);
        await bounded(this.turn.drained, undefined, 5_000);
      }
    } catch {
      // A broken CLI may never answer interrupt. close() terminates it before pending MCP handlers are released.
    } finally {
      this.query.close();
      try { this.input.close(); } catch { /* the input may already have closed with the CLI */ }
      await bounded(this.pump, undefined, 5_000).catch(() => {});
      await this.bridge.close();
    }
  }
}
