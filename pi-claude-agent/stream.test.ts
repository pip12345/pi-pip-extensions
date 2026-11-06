import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ToolBridge } from "./src/bridge.ts";
import { emptyUsage, StreamConverter } from "./src/stream.ts";
import { modelDefinition } from "./src/provider.ts";

function setup() {
  const model = modelDefinition({ value: "sonnet", displayName: "Sonnet", description: "" }, false);
  const output: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: model.api, content: [], usage: emptyUsage(), stopReason: "pending", timestamp: 0 };
  const stream = createAssistantMessageEventStream();
  const converter = new StreamConverter(output, stream, model, new ToolBridge([]));
  const emit = (value: unknown) => converter.accept(value as SDKMessage);
  const event = (event: unknown) => emit({ type: "stream_event", parent_tool_use_id: null, event });
  return { model, output, stream, converter, emit, event };
}

describe("Claude SDK stream conversion", () => {
  it("emits balanced summarized-thinking blocks without replaying private reasoning signatures", async () => {
    const { output, stream, event, emit } = setup();
    event({ type: "message_start", message: { id: "one", model: "sonnet", usage: {} } });
    event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "summary 🦊" } });
    event({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "native-only" } });
    event({ type: "content_block_stop", index: 0 });
    emit({ type: "assistant", parent_tool_use_id: null, message: { id: "one", model: "sonnet", usage: {}, content: [{ type: "thinking", thinking: "summary 🦊", signature: "native-only" }] } });
    stream.end(output);
    const events = [];
    for await (const event of stream) events.push(event.type);
    expect(events).toEqual(["thinking_start", "thinking_delta", "thinking_end"]);
    expect(output.content).toEqual([{ type: "thinking", thinking: "summary 🦊" }]);
  });

  it("uses complete assistant messages when no partial events were emitted and ignores repeats", () => {
    const { output, emit } = setup();
    const message = { type: "assistant", parent_tool_use_id: null, message: { id: "one", model: "sonnet", usage: { input_tokens: 2, output_tokens: 3 }, content: [{ type: "text", text: "complete response" }] } };
    emit(message); emit(message);
    expect(output.content).toEqual([{ type: "text", text: "complete response" }]);
    expect(output.usage.totalTokens).toBe(5);
  });

  it("preserves context-overflow and plan-limit errors instead of turning them into answers", () => {
    const { emit } = setup();
    expect(() => emit({ type: "assistant", error: "invalid_request", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Prompt is too long for the context window" }] } })).toThrow("context window");
    expect(() => emit({ type: "result", subtype: "success", is_error: true, result: "Your plan usage limit has been reached" })).toThrow("usage limit");
  });

  it("does not expose calls to tools that were never offered to Claude", () => {
    const { output, converter, emit } = setup();
    emit({ type: "assistant", parent_tool_use_id: null, message: { id: "one", model: "sonnet", usage: {}, content: [{ type: "tool_use", id: "bad", name: "Bash", input: { command: "not allowed" } }] } });
    expect(output.content).toEqual([]);
    expect(converter.hasTools).toBe(false);
  });

  it("rejects missing block boundaries rather than reporting truncated text as a successful answer", () => {
    const { output, converter, event } = setup();
    event({ type: "message_start", message: { id: "one", model: "sonnet", usage: {} } });
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } });
    expect(() => event({ type: "message_stop" })).toThrow("before closing");
    converter.closeBlocks();
    expect(output.content).toEqual([{ type: "text", text: "partial" }]);
  });

  it("rejects orphaned text deltas", () => {
    const { event } = setup();
    expect(() => event({ type: "content_block_delta", index: 8, delta: { type: "text_delta", text: "lost" } })).toThrow("matching content block");
  });

  it("records output length stops and ignores invalid token counts", () => {
    const { converter, output, event } = setup();
    event({ type: "message_start", message: { id: "one", model: "sonnet", usage: { input_tokens: -1, output_tokens: NaN } } });
    event({ type: "message_delta", usage: { output_tokens: 12 }, delta: { stop_reason: "max_tokens" } });
    expect(converter.length).toBe(true);
    expect(output.usage).toMatchObject({ input: 0, output: 12, totalTokens: 12 });
  });
});
