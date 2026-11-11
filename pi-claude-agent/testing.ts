import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Options, Query, SDKMessage, SDKUserMessage, SDKControlInitializeResponse } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSDK } from "./src/sdk.ts";

export class Queue<T> {
  private items: T[] = [];
  private wake?: () => void;
  private ended = false;
  push(item: T): void { if (!this.ended) { this.items.push(item); this.wake?.(); } }
  end(): void { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const item = this.items.shift();
      if (item !== undefined) yield item;
      else if (this.ended) return;
      else await new Promise<void>((done) => { this.wake = done; });
    }
  }
}

export type Script = (run: FakeRun, input: SDKUserMessage, index: number) => Promise<void> | void;

export class FakeRun {
  readonly events = new Queue<SDKMessage>();
  readonly inputs: SDKUserMessage[] = [];
  readonly outputs: unknown[] = [];
  readonly ready: Promise<SDKControlInitializeResponse>;
  readonly query: Query;
  client?: Client;
  closed = false;
  interrupts = 0;
  apiCalls = 0;

  constructor(readonly options: Options, prompt: AsyncIterable<SDKUserMessage>, script: Script) {
    const ready = this.initialize();
    this.ready = ready;
    this.query = Object.assign(this.events[Symbol.asyncIterator](), {
      initializationResult: () => this.ready,
      setModel: async () => {},
      getContextUsage: async () => ({ rawMaxTokens: 1_000_000 }),
      interrupt: async () => {
        this.interrupts++;
        this.result();
      },
      close: () => {
        this.closed = true;
        this.events.end();
        void this.client?.close();
      },
    }) as unknown as Query;
    void (async () => {
      await ready;
      for await (const input of prompt) {
        this.inputs.push(input);
        await script(this, input, this.inputs.length - 1);
      }
    })().catch((error) => { if (!this.closed) this.emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: [String(error)] }); });
  }

  private async initialize(): Promise<SDKControlInitializeResponse> {
    const config = this.options.mcpServers?.pi;
    if (config?.type === "sdk") {
      const [left, right] = InMemoryTransport.createLinkedPair();
      await (config.instance as unknown as Server).connect(left);
      this.client = new Client({ name: "fake-claude", version: "1" });
      await this.client.connect(right);
    }
    return {
      claude_code_version: "2.1.301",
      account: { apiKeySource: "environment", apiProvider: "firstParty" },
      models: [{ value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet", description: "", supportedEffortLevels: ["low", "medium", "high", "max"] }],
    } as SDKControlInitializeResponse;
  }

  emit(message: unknown): void { this.events.push(message as SDKMessage); }

  reply(text: string, calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []): void {
    if (this.closed) return;
    this.apiCalls++;
    const id = `msg-${this.apiCalls}`;
    this.emit({ type: "system", subtype: "init", mcp_servers: this.client ? [{ name: "pi", status: "connected" }] : [] });
    const usage = { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 };
    const message = { id, model: this.options.model ?? "sonnet", usage };
    this.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message } });
    if (text) {
      this.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
      for (const char of Array.from(text)) this.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: char } } });
      this.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index: 0 } });
    }
    const content = [...(text ? [{ type: "text", text }] : []), ...calls.map((call) => ({ type: "tool_use", ...call }))];
    this.emit({ type: "assistant", uuid: `${id}-uuid`, session_id: "native-session", parent_tool_use_id: null, message: { ...message, usage: { ...usage, output_tokens: 4 }, content } });
    this.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", usage: { output_tokens: 4 }, delta: { stop_reason: calls.length ? "tool_use" : "end_turn" } } });
    this.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } });
  }

  result(): void { this.emit({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", usage: { input_tokens: 999, output_tokens: 999 }, result: "done" }); }

  async call(id: string, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    for (const group of this.options.hooks?.PreToolUse ?? []) {
      for (const hook of group.hooks) {
        await hook({ hook_event_name: "PreToolUse", tool_use_id: id, tool_name: `mcp__pi__${name}`, tool_input: args } as Parameters<typeof hook>[0], undefined, { signal: new AbortController().signal });
      }
    }
    if (!this.client) throw new Error("No MCP client");
    const output = await this.client.callTool({ name, arguments: args });
    this.outputs.push(output);
    return output;
  }
}

export function fakeSDK(script: Script) {
  const runs: FakeRun[] = [];
  const sdk: AgentSDK = {
    query: ({ options = {}, prompt }) => {
      if (typeof prompt === "string") throw new Error("Expected streaming input");
      const run = new FakeRun(options, prompt, script);
      runs.push(run);
      return run.query;
    },
  };
  return { sdk, runs };
}
