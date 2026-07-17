import { EventEmitter } from "node:events";
import type { JsonRpcId, JsonRpcMessage } from "./jsonrpc.ts";
import type { TinyMcpServerConfig } from "./types.ts";
import { MAX_MCP_ERROR_BODY_BYTES, MAX_MCP_MESSAGE_BYTES, readBoundedResponseText } from "./transport-limits.ts";

interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

export interface HttpTransportOptions {
  config: TinyMcpServerConfig;
}

type HttpMode = "streamable" | "legacy";

export class HttpTransport extends EventEmitter {
  private readonly url: URL;
  private readonly headers: Record<string, string>;
  private readonly legacyOnly: boolean;
  private abortController?: AbortController;
  private closed = false;
  private sessionId?: string;
  private protocolVersion?: string;
  private mode: HttpMode = "streamable";
  private legacyEndpoint?: URL;
  private legacyStart?: Promise<void>;
  private getStreamStarted = false;
  private initializedPost?: Promise<void>;

  constructor(options: HttpTransportOptions) {
    super();
    if (!options.config.url) throw new Error("HTTP MCP server requires url");
    this.url = new URL(options.config.url);
    if (this.url.protocol !== "http:" && this.url.protocol !== "https:") throw new Error(`HTTP MCP url must use http or https: ${this.url.href}`);
    this.headers = { ...(options.config.headers ?? {}) };
    this.legacyOnly = options.config.type === "sse";
    if (this.legacyOnly) this.mode = "legacy";
  }

  start(): void {
    if (this.abortController && !this.closed) return;
    this.abortController = new AbortController();
    this.closed = false;
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  send(message: JsonRpcMessage, signal?: AbortSignal): void {
    if (this.closed) throw new Error("HTTP MCP transport is closed");
    this.start();

    let operation: Promise<void>;
    if (isInitializedNotification(message)) {
      operation = this.postMessage(message, signal).then(() => {
        if (this.mode === "streamable") this.startGetStream();
      });
      this.initializedPost = operation;
    } else if (this.initializedPost && !isInitializeRequest(message)) {
      operation = waitForSignal(this.initializedPost, signal).then(() => this.postMessage(message, signal));
    } else {
      operation = this.postMessage(message, signal);
    }

    void operation.catch((error) => {
      const normalized = normalizeError(error);
      if (!this.closed && normalized.name !== "AbortError") this.emit("error", normalized);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortController?.abort();
    this.abortController = undefined;
    this.emit("close", { code: 0, signal: undefined });
  }

  private async postMessage(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
    if (this.legacyOnly || this.mode === "legacy") return this.postLegacy(message, signal);
    return this.postStreamable(message, signal);
  }

  private async postStreamable(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: this.commonHeaders({
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(message),
      signal: combinedSignal(this.abortController?.signal, signal),
    });

    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;

    if (!response.ok) {
      const text = await safeText(response);
      if (shouldFallbackToLegacy(response.status, message)) {
        await response.body?.cancel().catch(() => undefined);
        this.mode = "legacy";
        await this.startLegacySse(signal);
        await this.postLegacy(message, signal);
        return;
      }
      throw new Error(formatHttpError(response, text));
    }

    if (response.status === 202 || response.status === 204) {
      await response.body?.cancel().catch(() => undefined);
      if (isJsonRpcRequest(message)) throw new Error(`HTTP MCP server returned ${response.status} without a JSON-RPC response`);
      return;
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/event-stream")) {
      await this.consumePostSse(response.body, isJsonRpcRequest(message) ? message.id : undefined);
      return;
    }
    if (isJsonContentType(contentType)) {
      const payload = JSON.parse(await readBoundedResponseText(response, MAX_MCP_MESSAGE_BYTES));
      this.emitJsonPayload(payload);
      return;
    }

    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Unexpected HTTP MCP response content-type: ${contentType || "(none)"}`);
  }

  private async postLegacy(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
    await this.startLegacySse(signal);
    if (!this.legacyEndpoint) throw new Error("Legacy SSE MCP endpoint was not received");
    const response = await fetch(this.legacyEndpoint, {
      method: "POST",
      headers: this.commonHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(message),
      signal: combinedSignal(this.abortController?.signal, signal),
    });
    if (!response.ok) throw new Error(formatHttpError(response, await safeText(response)));
    await response.body?.cancel().catch(() => undefined);
  }

  private async consumePostSse(stream: ReadableStream<Uint8Array> | null, requestId?: JsonRpcId): Promise<void> {
    if (!stream) throw new Error("HTTP MCP SSE response had no body");
    let sawResponse = requestId === undefined;
    await readSseStream(stream, async (event) => {
      if (!isMessageEvent(event) || !event.data || event.data === "[DONE]") return;
      const message = parseJsonRpcEvent(event.data);
      this.emit("message", message);
      if (requestId !== undefined && isResponseFor(message, requestId)) {
        sawResponse = true;
        return "stop";
      }
    });
    if (!sawResponse) throw new Error("HTTP MCP SSE stream ended before JSON-RPC response");
  }

  private startGetStream(): void {
    if (this.getStreamStarted || this.closed) return;
    this.getStreamStarted = true;
    void this.runGetStream().catch((error) => {
      // GET streams are optional for Streamable HTTP. Ignore unsupported or
      // transient failures; request/response POSTs still carry normal traffic.
      if (!this.closed) this.emit("notification", "http/get_stream_error", normalizeError(error).message);
    });
  }

  private async runGetStream(): Promise<void> {
    const response = await fetch(this.url, {
      method: "GET",
      headers: this.commonHeaders({ Accept: "text/event-stream" }),
      signal: this.abortController?.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/event-stream")) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    await readSseStream(response.body, async (event) => {
      if (!isMessageEvent(event) || !event.data || event.data === "[DONE]") return;
      this.emit("message", parseJsonRpcEvent(event.data));
    });
  }

  private async startLegacySse(signal?: AbortSignal): Promise<void> {
    if (this.legacyEndpoint) return;
    if (this.legacyStart) return this.legacyStart;

    this.legacyStart = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const settleReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(normalizeError(error));
      };

      void (async () => {
        const response = await fetch(this.url, {
          method: "GET",
          headers: this.commonHeaders({ Accept: "text/event-stream" }),
          signal: combinedSignal(this.abortController?.signal, signal),
        });
        if (!response.ok) throw new Error(formatHttpError(response, await safeText(response)));
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (!contentType.includes("text/event-stream")) throw new Error(`Legacy SSE MCP endpoint returned content-type: ${contentType || "(none)"}`);
        await readSseStream(response.body, async (event) => {
          if (event.event === "endpoint") {
            this.legacyEndpoint = resolveLegacyEndpoint(this.url, event.data);
            settleResolve();
            return;
          }
          if (!isMessageEvent(event) || !event.data || event.data === "[DONE]") return;
          this.emit("message", parseJsonRpcEvent(event.data));
        });
        if (!this.legacyEndpoint) settleReject(new Error("Legacy SSE MCP stream ended before endpoint event"));
      })().catch((error) => {
        const wasSettled = settled;
        settleReject(error);
        if (!this.closed && wasSettled) this.emit("error", normalizeError(error));
      });
    });

    return this.legacyStart;
  }

  private commonHeaders(extra: Record<string, string>): Headers {
    const headers = new Headers({ ...this.headers, ...extra });
    if (this.sessionId) headers.set("MCP-Session-Id", this.sessionId);
    if (this.protocolVersion) headers.set("MCP-Protocol-Version", this.protocolVersion);
    return headers;
  }

  private emitJsonPayload(payload: unknown): void {
    const messages = Array.isArray(payload) ? payload : [payload];
    for (const message of messages) this.emit("message", validateJsonRpcMessage(message));
  }
}

async function readSseStream(
  stream: ReadableStream<Uint8Array> | null,
  onEvent: (event: SseEvent) => Promise<"stop" | void> | "stop" | void,
): Promise<void> {
  if (!stream) throw new Error("SSE response had no body");
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  let dataLines: string[] = [];
  let eventBytes = 0;

  const assertBounded = (bytes: number) => {
    if (bytes > MAX_MCP_MESSAGE_BYTES) throw new Error(`HTTP MCP SSE event exceeded ${MAX_MCP_MESSAGE_BYTES} byte limit`);
  };

  const dispatch = async (): Promise<boolean> => {
    if (!eventName && id === undefined && retry === undefined && dataLines.length === 0) {
      eventBytes = 0;
      return false;
    }
    const event: SseEvent = { event: eventName, data: dataLines.join("\n"), id, retry };
    eventName = undefined;
    id = undefined;
    retry = undefined;
    dataLines = [];
    eventBytes = 0;
    const result = await onEvent(event);
    if (result === "stop") {
      await reader.cancel().catch(() => undefined);
      return true;
    }
    return false;
  };

  const processLine = async (line: string): Promise<boolean> => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "") return dispatch();
    eventBytes += Buffer.byteLength(line, "utf8") + 1;
    assertBounded(eventBytes);
    if (line.startsWith(":")) return false;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") id = value;
    else if (field === "retry") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) retry = parsed;
    }
    return false;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (await processLine(line)) return;
    }
    assertBounded(eventBytes + Buffer.byteLength(buffer, "utf8"));
  }

  buffer += decoder.decode();
  assertBounded(eventBytes + Buffer.byteLength(buffer, "utf8"));
  if (buffer) await processLine(buffer);
  await dispatch();
}

function parseJsonRpcEvent(data: string): JsonRpcMessage {
  return validateJsonRpcMessage(JSON.parse(data));
}

function validateJsonRpcMessage(value: unknown): JsonRpcMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid JSON-RPC message from HTTP MCP server");
  const message = value as JsonRpcMessage;
  if (message.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC message from HTTP MCP server: missing jsonrpc=2.0");
  return message;
}

function isMessageEvent(event: SseEvent): boolean {
  return event.event === undefined || event.event === "message";
}

function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcMessage & { id: JsonRpcId; method: string } {
  return typeof message.method === "string" && "id" in message;
}

function isInitializeRequest(message: JsonRpcMessage): boolean {
  return isJsonRpcRequest(message) && message.method === "initialize";
}

function isInitializedNotification(message: JsonRpcMessage): boolean {
  return message.method === "notifications/initialized" && !("id" in message);
}

function isResponseFor(message: JsonRpcMessage, requestId: JsonRpcId): boolean {
  return message.id === requestId && ("result" in message || "error" in message);
}

function shouldFallbackToLegacy(status: number, message: JsonRpcMessage): boolean {
  return isInitializeRequest(message) && (status === 400 || status === 404 || status === 405);
}

function isJsonContentType(contentType: string): boolean {
  return contentType.includes("application/json") || /application\/[^;]+\+json/.test(contentType);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await readBoundedResponseText(response, MAX_MCP_ERROR_BODY_BYTES, "HTTP MCP error response");
  } catch {
    return "";
  }
}

function formatHttpError(response: Response, text: string): string {
  const authHint = response.status === 401 || response.status === 403 ? " Authentication may require static headers; OAuth is not supported by tiny-mcp." : "";
  const body = text.trim();
  return `HTTP MCP ${response.status} ${response.statusText}${authHint}${body ? `: ${body.slice(0, 500)}` : ""}`.trim();
}

function resolveLegacyEndpoint(base: URL, endpoint: string): URL {
  const url = new URL(endpoint, base);
  if (url.origin !== base.origin) throw new Error(`Legacy SSE endpoint origin does not match server origin: ${url.origin}`);
  return url;
}

function combinedSignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (!active.length) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

async function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function abortError(): Error {
  const error = new Error("HTTP MCP request aborted");
  error.name = "AbortError";
  return error;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
