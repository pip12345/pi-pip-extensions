import { EventEmitter } from "node:events";

export type JsonRpcId = string | number;
export type JsonRpcMessage = Record<string, any>;
type SendFn = (message: JsonRpcMessage) => void;
type RequestHandler = (params: any) => Promise<any> | any;

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export class JsonRpcPeer extends EventEmitter {
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private requestHandlers = new Map<string, RequestHandler>();

  constructor(private sendMessage: SendFn) {
    super();
  }

  request(method: string, params?: any, timeoutMs = 30000): Promise<any> {
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    const promise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.notify("notifications/cancelled", { requestId: id, reason: `Request timed out after ${timeoutMs}ms` });
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    this.sendMessage(message);
    return promise;
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
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private handleResponse(message: JsonRpcMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`MCP ${pending.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`));
    else pending.resolve(message.result);
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
