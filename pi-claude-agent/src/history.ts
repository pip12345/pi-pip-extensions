import { createHash } from "node:crypto";
import type { Message, TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type ConversationMessage = Exclude<Message, { role: "system" }>;
export type InputContent = Exclude<SDKUserMessage["message"]["content"], string>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// Provider metadata, timestamps, and reasoning are not replayable conversation state.
// Ignoring them also lets message_end extensions annotate a response without invalidating its native session.
export function fingerprint(message: ConversationMessage): string {
  let value: unknown;
  if (message.role === "assistant") {
    value = { role: message.role, content: message.content.filter((part) => part.type !== "thinking").map((part) =>
      part.type === "toolCall" ? { type: part.type, id: part.id, name: part.name, arguments: part.arguments } : { type: part.type, text: part.text }) };
  } else if (message.role === "toolResult") {
    value = { role: message.role, id: message.toolCallId, content: message.content, isError: message.isError };
  } else {
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    value = { role: message.role, content };
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function matches(messages: ConversationMessage[], history: readonly string[]): boolean {
  return messages.length >= history.length && history.every((hash, index) => fingerprint(messages[index]!) === hash);
}

function media(content: readonly (TextContent | ImageContent)[]): InputContent {
  return content.map((part) => part.type === "text" ? { type: "text", text: part.text } : {
    type: "image", source: { type: "base64", media_type: part.mimeType as "image/png", data: part.data },
  });
}

function render(messages: readonly ConversationMessage[], checkpoint = false): InputContent {
  const result: InputContent = [];
  for (const message of messages) {
    if (message.role === "user") {
      if (checkpoint) result.push({ type: "text", text: "[user]" });
      result.push(...(typeof message.content === "string" ? [{ type: "text" as const, text: message.content || "(empty message)" }] : media(message.content)));
    } else if (message.role === "assistant") {
      result.push({ type: "text", text: "[assistant]" });
      for (const part of message.content) {
        if (part.type === "text") result.push({ type: "text", text: part.text });
        if (part.type === "toolCall") result.push({ type: "text", text: `[tool call ${part.id}: ${part.name}]\n${JSON.stringify(part.arguments)}` });
      }
    } else {
      result.push({ type: "text", text: `[tool result ${message.toolCallId}: ${message.toolName}${message.isError ? ", error" : ""}]` });
      result.push(...media(message.content));
    }
  }
  return result;
}

export function inputContent(messages: readonly ConversationMessage[]): InputContent {
  let end = messages.length;
  while (end > 0 && messages[end - 1]!.role === "user") end--;
  const result: InputContent = [];
  if (end > 0) {
    result.push({ type: "text", text: "<conversation-checkpoint>\nThis is prior conversation from Pi, not a new request. Continue from the user messages after this checkpoint." });
    result.push(...render(messages.slice(0, end), true));
    result.push({ type: "text", text: "</conversation-checkpoint>" });
  }
  result.push(...render(messages.slice(end)));
  return result.length ? result : [{ type: "text", text: "Continue the conversation." }];
}
