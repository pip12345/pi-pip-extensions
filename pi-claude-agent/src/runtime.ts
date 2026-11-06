import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  clampThinkingLevel, createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools,
  type Api, type AssistantMessage, type AssistantMessageEventStream, type Model,
  type SimpleStreamOptions, type ToolResultMessage, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ToolBridge } from "./bridge.ts";
import { fingerprint, inputContent, matches, type ConversationMessage } from "./history.ts";
import { baseOptions, bounded, IDLE_MS, loadSDK, requireExecutable, type AgentSDK } from "./sdk.ts";
import { ClaudeSession } from "./session.ts";
import { emptyUsage, StreamConverter } from "./stream.ts";

interface Entry {
  queue: Promise<void>;
  session?: ClaudeSession;
  launch?: string;
  history: string[];
  waiting: string[];
  timer?: ReturnType<typeof setTimeout>;
  active: boolean;
  pending: number;
  abort: AbortController;
}

export interface RuntimeDependencies {
  loadSDK?: () => Promise<AgentSDK>;
  executable?: (env: NodeJS.ProcessEnv) => string;
  cwd?: () => string;
  idleMs?: number;
}

export class ClaudeRuntime {
  private readonly entries = new Map<string, Entry>();
  private cwd: string;
  constructor(private readonly dependencies: RuntimeDependencies = {}) {
    this.cwd = dependencies.cwd?.() ?? process.cwd();
  }
  setCwd(cwd: string): void { this.cwd = cwd; }

  private async reset(entry: Entry): Promise<void> {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const session = entry.session;
    entry.session = undefined;
    entry.history = [];
    entry.waiting = [];
    entry.launch = undefined;
    await session?.stop();
  }

  private armIdle(key: string, entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (entry.active || entry.pending) return;
      void this.reset(entry).finally(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      }).catch(() => {});
    }, this.dependencies.idleMs ?? IDLE_MS);
    entry.timer.unref();
  }

  idle(): void {
    for (const [key, entry] of this.entries) if (!entry.active) this.armIdle(key, entry);
  }

  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) entry.abort.abort(new Error("Claude Agent session was closed."));
    await Promise.all(entries.map((entry) => this.reset(entry)));
  }

  stream(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions = {}): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const output: AssistantMessage = {
      role: "assistant", provider: model.provider, model: model.id, api: model.api,
      content: [], stopReason: "pending", usage: emptyUsage(), timestamp: Date.now(),
    };
    void this.run(model, context, options, stream, output);
    return stream;
  }

  private async run(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions,
    stream: AssistantMessageEventStream, output: AssistantMessage): Promise<void> {
    const key = options.sessionId ?? crypto.randomUUID();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { queue: Promise.resolve(), history: [], waiting: [], active: false, pending: 0, abort: new AbortController() };
      this.entries.set(key, entry);
    }
    entry.pending++;
    options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, entry.abort.signal]) : entry.abort.signal };
    const previous = entry.queue;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    // A cancelled waiter must not let the next request overtake the request still holding the session.
    entry.queue = previous.then(() => gate);
    let converter: StreamConverter | undefined;
    let acquired = false;
    try {
      await bounded(previous, options.signal, 10 * 60_000);
      options.signal?.throwIfAborted();
      acquired = true;
      entry.active = true;
      clearTimeout(entry.timer);
      if (options.fetch) throw new Error("Claude Agent cannot use a custom fetch implementation. Claude Code owns the HTTP transport.");
      if (options.deferred) throw new Error("Claude Agent does not support deferred requests.");
      const env = { ...process.env, ...options.env };
      if (options.apiKey) env.ANTHROPIC_API_KEY = options.apiKey;
      if (model.baseUrl && model.baseUrl !== "https://api.anthropic.com") env.ANTHROPIC_BASE_URL = model.baseUrl;
      const headers = Object.entries(options.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string");
      if (headers.length) env.ANTHROPIC_CUSTOM_HEADERS = [env.ANTHROPIC_CUSTOM_HEADERS, ...headers.map(([key, value]) => `${key}: ${value}`)].filter(Boolean).join("\n");
      const path = (this.dependencies.executable ?? requireExecutable)(env);
      const tools = options.toolChoice === "none" ? [] : getCurrentTools(context.messages);
      const messages = context.messages.filter((message): message is ConversationMessage => message.role !== "system");
      const thinking = !options.reasoning && model.thinkingLevelMap?.off === "off"
        ? { type: "disabled" as const } : { type: "adaptive" as const, display: "summarized" as const };
      const level = options.reasoning ? clampThinkingLevel(model, options.reasoning) : "off";
      const effort = level === "off" ? undefined : model.thinkingLevelMap?.[level] ?? undefined;
      if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`Unsupported Claude effort: ${effort}`);
      const system = {
        type: "preset" as const, preset: "claude_code" as const, snapshot: false,
        append: `<runtime_info>You are running in Pi through the Claude Code harness. Mention this only when asked.</runtime_info>\n\n${getCurrentSystemPrompt(context.messages)}`,
      };
      const launchOptions: Options = {
        ...baseOptions(path, this.cwd, env),
        model: model.id,
        thinking,
        effort: effort as Options["effort"],
        systemPrompt: system,
        ...(options.maxTokens ? { env: { ...baseOptions(path, this.cwd, env).env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(options.maxTokens) } } : {}),
      };
      // This is a logical SDK request, not the private HTTP payload produced by Claude Code.
      // HTTP response/header hooks cannot run because the SDK owns that transport.
      const payload = { model: model.id, systemPrompt: system, messages, tools, effort, maxTokens: options.maxTokens };
      const originalPayload = JSON.stringify(payload);
      const replacement = await options.onPayload?.(payload, model);
      if ((replacement !== undefined && replacement !== payload) || JSON.stringify(payload) !== originalPayload) throw new Error("Claude Agent does not support replacing SDK request payloads. Change the transcript or provider environment instead.");
      const launch = JSON.stringify([path, this.cwd, launchOptions.env, system, model.id, thinking, effort, tools]);
      let tail = messages.slice(entry.history.length);
      let results: ToolResultMessage[] | undefined;
      if (entry.session && entry.launch === launch && matches(messages, entry.history)) {
        if (entry.waiting.length) {
          const resultEnd = tail.findIndex((message) => message.role !== "toolResult");
          const resultMessages = tail.slice(0, resultEnd < 0 ? tail.length : resultEnd) as ToolResultMessage[];
          const byID = new Map(resultMessages.map((result) => [result.toolCallId, result]));
          if (entry.waiting.every((id) => byID.has(id)) && resultMessages.length === entry.waiting.length) {
            results = entry.waiting.map((id) => byID.get(id)!);
            tail = tail.slice(resultMessages.length);
          } else await this.reset(entry);
        } else if (!tail.length) await this.reset(entry);
      } else await this.reset(entry);

      if (!entry.session) {
        const sdk = await (this.dependencies.loadSDK ?? loadSDK)();
        options.signal?.throwIfAborted();
        const bridge = new ToolBridge(tools);
        try {
          launchOptions.hooks = bridge.hooks;
          launchOptions.mcpServers = tools.length ? { pi: await bridge.server() } : {};
          options.signal?.throwIfAborted();
          entry.session = new ClaudeSession(sdk, launchOptions, bridge);
          entry.launch = launch;
          await bounded(entry.session.ready, options.signal);
        } catch (error) { await bridge.close(); throw error; }
        tail = messages;
        results = undefined;
      }
      const session = entry.session;
      const costModel = !env.ANTHROPIC_BASE_URL && session.account?.apiProvider === "firstParty" && session.account.apiKeySource
        ? model : { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      converter = new StreamConverter(output, stream, costModel, session.bridge);
      output.providerThinkingLevel = effort;
      stream.push({ type: "start", partial: output });
      if (results) session.continue(results, tail.length ? inputContent(tail) : undefined);
      else session.begin(inputContent(tail));
      const outcome = await session.readStep(async (message) => {
        await options.onProviderStreamEvent?.(message, model);
        converter!.accept(message);
        return converter!.hasTools;
      }, options.signal);
      options.signal?.throwIfAborted();
      converter.closeBlocks();
      if (outcome === "stop" && converter.hasTools) throw new Error("Claude ended its turn before accepting Pi's tool results.");
      output.stopReason = outcome === "tools" ? "toolUse" : converter.length ? "length" : "stop";
      entry.history = [...messages.map(fingerprint), fingerprint(output)];
      entry.waiting = output.content.filter((part) => part.type === "toolCall").map((part) => part.id);
      stream.push({ type: "done", reason: output.stopReason, message: output });
    } catch (error) {
      converter?.closeBlocks();
      if (acquired) await this.reset(entry).catch(() => {});
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
    } finally {
      entry.pending--;
      if (acquired) {
        entry.active = false;
        if (!options.sessionId) {
          await this.reset(entry).catch(() => {});
          if (this.entries.get(key) === entry) this.entries.delete(key);
        } else if (!entry.waiting.length && !entry.pending && !entry.abort.signal.aborted) this.armIdle(key, entry);
      }
      release();
      stream.end();
    }
  }
}
