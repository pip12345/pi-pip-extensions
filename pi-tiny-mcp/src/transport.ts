import type { EventEmitter } from "node:events";
import type { JsonRpcMessage } from "./jsonrpc.ts";

export interface McpTransport extends EventEmitter {
  start(): void | Promise<void>;
  send(message: JsonRpcMessage, signal?: AbortSignal): void;
  close(): Promise<void>;
  tail?(): string[];
  setProtocolVersion?(version: string): void;
}
