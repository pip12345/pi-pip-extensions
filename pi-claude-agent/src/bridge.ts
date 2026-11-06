import type { McpSdkServerConfigWithInstance, Options } from "@anthropic-ai/claude-agent-sdk";
import type { Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface WaitingCall {
  name: string;
  promise: Promise<CallToolResult>;
  resolve: (result: CallToolResult) => void;
}

export class ToolBridge {
  readonly names = new Map<string, string>();
  private readonly calls = new Map<string, WaitingCall>();
  private next: string | undefined;
  private closeServer?: () => Promise<void>;

  constructor(readonly tools: readonly Tool[]) {
    tools.forEach((tool, index) => {
      const short = `t${index}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)}`;
      this.names.set(`mcp__pi__${short}`, tool.name);
    });
  }

  original(name: string): string | undefined { return this.names.get(name); }

  expect(id: string, name: string): WaitingCall {
    if (!this.names.has(name)) throw new Error(`Claude called an unregistered Pi tool: ${name}`);
    const existing = this.calls.get(id);
    if (existing) {
      if (existing.name !== name) throw new Error("Claude tool-call ID was reused for another tool.");
      return existing;
    }
    let resolve!: WaitingCall["resolve"];
    const promise = new Promise<CallToolResult>((done) => { resolve = done; });
    const call = { name, promise, resolve };
    this.calls.set(id, call);
    return call;
  }

  readonly hooks: Options["hooks"] = {
    PreToolUse: [{ hooks: [async (input) => {
      if (input.hook_event_name === "PreToolUse") {
        this.expect(input.tool_use_id, input.tool_name);
        if (this.next) throw new Error("Claude invoked Pi tools concurrently without a matching handler.");
        this.next = input.tool_use_id;
      }
      return {};
    }] }],
  };

  async call(name: string): Promise<CallToolResult> {
    const id = this.next;
    this.next = undefined;
    if (!id) throw new Error("Claude invoked a Pi tool without its PreToolUse ID.");
    const call = this.expect(id, name);
    const result = await call.promise;
    this.calls.delete(id);
    return result;
  }

  resolve(result: ToolResultMessage): void {
    const call = this.calls.get(result.toolCallId);
    if (!call) throw new Error(`No Claude tool call is waiting for result ${result.toolCallId}.`);
    call.resolve({
      isError: result.isError,
      content: result.content.length ? result.content.map((part) => part.type === "text"
        ? { type: "text" as const, text: part.text }
        : { type: "image" as const, data: part.data, mimeType: part.mimeType })
        : [{ type: "text", text: "(empty tool result)" }],
    });
  }

  async server(): Promise<McpSdkServerConfigWithInstance> {
    const [{ Server }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/index.js"), import("@modelcontextprotocol/sdk/types.js"),
    ]);
    const server = new Server({ name: "pi", version: "0.1.0" }, { capabilities: { tools: {} } });
    const definitions = [...this.names].map(([name], index) => ({
      name: name.slice("mcp__pi__".length),
      description: this.tools[index]!.description,
      inputSchema: this.tools[index]!.parameters as unknown as { type: "object"; [key: string]: unknown },
      // The SDK hook supplies only one current call ID. Serial MCP execution keeps that ID paired
      // with its handler. Pi still executes the emitted tool calls through its own normal tool loop.
      annotations: { readOnlyHint: false },
      _meta: { "anthropic/alwaysLoad": true, "anthropic/maxResultSizeChars": 500_000 },
    }));
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => this.call(`mcp__pi__${request.params.name}`));
    this.closeServer = () => server.close();
    // The SDK's public type names McpServer, but its SDK transport uses the underlying Server interface.
    return { type: "sdk", name: "pi", instance: server as unknown as McpSdkServerConfigWithInstance["instance"] };
  }

  async close(): Promise<void> {
    // The caller must interrupt/drain or close Claude first. Resolving earlier could start a new
    // inference with synthetic cancellation results while Pi is trying to stop the conversation.
    for (const call of this.calls.values()) call.resolve({ isError: true, content: [{ type: "text", text: "Cancelled by user." }] });
    this.calls.clear();
    this.next = undefined;
    await this.closeServer?.();
  }
}
