import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  calculateCost, type AssistantMessage, type AssistantMessageEventStream, type Model, type Api, type Usage, type ToolCall,
} from "@earendil-works/pi-ai";
import type { ToolBridge } from "./bridge.ts";

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export class StreamConverter {
  private messageID = "";
  private readonly streamed = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly blocks = new Map<number, number>();
  private readonly open = new Set<number>();
  private readonly toolIDs = new Set<string>();
  private readonly usages = new Map<string, { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }>();
  hasTools = false;
  length = false;

  constructor(readonly output: AssistantMessage, readonly stream: AssistantMessageEventStream, readonly model: Model<Api>, readonly bridge: ToolBridge) {}

  private usage(id: string, value: Record<string, unknown>): void {
    const saved = this.usages.get(id) ?? {};
    for (const field of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
      if (typeof value[field] === "number" && Number.isFinite(value[field]) && value[field] >= 0) saved[field] = Math.max(saved[field] ?? 0, value[field]);
    }
    this.usages.set(id, saved);
    const usage = emptyUsage();
    for (const value of this.usages.values()) {
      usage.input += value.input_tokens ?? 0;
      usage.output += value.output_tokens ?? 0;
      usage.cacheRead += value.cache_read_input_tokens ?? 0;
      usage.cacheWrite += value.cache_creation_input_tokens ?? 0;
    }
    usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    calculateCost(this.model, usage);
    this.output.usage = usage;
  }

  private start(kind: "text" | "thinking", initial: string, index?: number): number {
    const contentIndex = this.output.content.length;
    this.output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
    if (index !== undefined) this.blocks.set(index, contentIndex);
    this.open.add(contentIndex);
    this.stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex, partial: this.output });
    if (initial) this.delta(contentIndex, initial);
    return contentIndex;
  }

  private delta(contentIndex: number, delta: string): void {
    const block = this.output.content[contentIndex];
    if (block?.type === "text") {
      block.text += delta;
      this.stream.push({ type: "text_delta", contentIndex, delta, partial: this.output });
    } else if (block?.type === "thinking") {
      block.thinking += delta;
      this.stream.push({ type: "thinking_delta", contentIndex, delta, partial: this.output });
    }
  }

  private end(contentIndex: number): void {
    if (!this.open.delete(contentIndex)) return;
    const block = this.output.content[contentIndex];
    if (block?.type === "text") this.stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.output });
    if (block?.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.output });
  }

  closeBlocks(): void { for (const index of this.open) this.end(index); }

  accept(message: SDKMessage): void {
    if (message.type === "stream_event" && message.parent_tool_use_id === null) {
      const event = message.event;
      switch (event.type) {
        case "message_start":
          if (this.open.size) throw new Error("Claude started a new response before closing its content blocks.");
          this.messageID = event.message.id;
          this.output.responseId = event.message.id;
          this.output.responseModel = event.message.model;
          this.streamed.add(this.messageID);
          this.blocks.clear();
          this.usage(this.messageID, event.message.usage as unknown as Record<string, unknown>);
          break;
        case "content_block_start":
          if (event.content_block.type === "text") this.start("text", event.content_block.text, event.index);
          if (event.content_block.type === "thinking") this.start("thinking", event.content_block.thinking, event.index);
          break;
        case "content_block_delta": {
          const index = this.blocks.get(event.index);
          if (index === undefined) {
            if (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") throw new Error("Claude streamed content without a matching content block.");
            break;
          }
          if (event.delta.type === "text_delta") this.delta(index, event.delta.text);
          if (event.delta.type === "thinking_delta") this.delta(index, event.delta.thinking);
          break;
        }
        case "content_block_stop": {
          const index = this.blocks.get(event.index);
          if (index !== undefined) this.end(index);
          break;
        }
        case "message_stop":
          if (this.open.size) throw new Error("Claude stopped its response before closing its content blocks.");
          break;
        case "message_delta":
          this.usage(this.messageID, event.usage as unknown as Record<string, unknown>);
          this.length = event.delta.stop_reason === "max_tokens";
          break;
      }
    }
    if (message.type === "assistant" && message.parent_tool_use_id === null) {
      if (message.error) {
        const text = message.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        throw new Error(text || `Claude Code reported ${message.error}.`);
      }
      this.usage(message.message.id, message.message.usage as unknown as Record<string, unknown>);
      this.output.responseModel = message.message.model;
      this.output.responseId = message.message.id;
      const repeated = this.completed.has(message.message.id);
      this.completed.add(message.message.id);
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          const name = this.bridge.original(block.name);
          if (!name || this.toolIDs.has(block.id)) continue;
          if (!block.input || typeof block.input !== "object" || Array.isArray(block.input)) throw new Error("Claude tool arguments are not an object.");
          this.bridge.expect(block.id, block.name);
          this.toolIDs.add(block.id);
          this.hasTools = true;
          const toolCall: ToolCall = { type: "toolCall", id: block.id, name, arguments: block.input as ToolCall["arguments"] };
          const contentIndex = this.output.content.length;
          this.output.content.push(toolCall);
          this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
          this.stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: this.output });
        }
        if (!repeated && !this.streamed.has(message.message.id)) {
          if (block.type === "text") this.end(this.start("text", block.text));
          if (block.type === "thinking") this.end(this.start("thinking", block.thinking));
        }
      }
    }
    if (message.type === "result") {
      if (this.open.size) throw new Error("Claude ended its turn with incomplete content blocks.");
      if (message.is_error) {
        throw new Error(message.subtype === "success" ? message.result || "Claude Code request failed." : message.errors.join("\n") || message.subtype);
      }
      if (!this.usages.size) this.usage("result", message.usage as unknown as Record<string, unknown>);
      this.length = message.stop_reason === "max_tokens";
    }
  }
}
