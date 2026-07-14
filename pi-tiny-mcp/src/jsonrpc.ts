import { EventEmitter } from "node:events";

function abortError(method: string): Error {
  const error = new Error(`MCP request aborted: ${method}`);
  error.name = "AbortError";
  return error;
}

export type JsonRpcId = string | number;
export type JsonRpcMessage = Record<string, any>;
type SendFn = (message: JsonRpcMessage, signal?: AbortSignal) => void;
type RequestHandler = (params: any) => Promise<any> | any;

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class JsonRpcPeer extends EventEmitter {
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private requestHandlers = new Map<string, RequestHandler>();

  constructor(private sendMessage: SendFn) {
    super();
  }

  request(method: string, params?: any, timeoutMs = 30000, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) return Promise.reject(abortError(method));
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.takePending(id);
        if (!pending) return;
        try { this.notify("notifications/cancelled", { requestId: id, reason: `Request timed out after ${timeoutMs}ms` }); } catch {}
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      const onAbort = signal ? () => {
        const pending = this.takePending(id);
        if (!pending) return;
        try { this.notify("notifications/cancelled", { requestId: id, reason: "Client request aborted" }); } catch {}
        reject(abortError(method));
      } : undefined;
      this.pending.set(id, { resolve, reject, timer, method, signal, onAbort });
      signal?.addEventListener("abort", onAbort!, { once: true });
      try {
        this.sendMessage(message, signal);
      } catch (error) {
        this.takePending(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: any): void {
    const message: JsonRpcMessage = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.sendMessage(message);
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  handle(message: JsonRpcMessage): void {
    if (message.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC message: missing jsonrpc=2.0");
    if ("id" in message && ("result" in message || "error" in message)) return this.handleResponse(message);
    if (typeof message.method === "string" && "id" in message) return void this.handleRequest(message);
    if (typeof message.method === "string") {
      this.emit("notification", message.method, message.params);
      this.emit(`notification:${message.method}`, message.params);
      return;
    }
    throw new Error("Invalid JSON-RPC message shape");
  }

  close(error = new Error("JSON-RPC peer closed")): void {
    for (const [id, pending] of this.pending) {
      this.takePending(id);
      pending.reject(error);
    }
  }

  private handleResponse(message: JsonRpcMessage): void {
    const pending = this.takePending(message.id);
    if (!pending) return;
    if (message.error) pending.reject(new Error(`MCP ${pending.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`));
    else pending.resolve(message.result);
  }

  private takePending(id: JsonRpcId): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    return pending;
  }

  private async handleRequest(message: JsonRpcMessage): Promise<void> {
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      this.sendMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      return;
    }
    try {
      const result = await handler(message.params);
      this.sendMessage({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.sendMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
    }
  }
}
