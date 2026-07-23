import { readResponseBytes, signalWithTimeout } from "./limits.ts";

export interface McpContentItem {
  type: string;
  text?: string;
}

export interface McpCallOptions {
  url: string;
  tool: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

function errorMessage(error: any): string {
  const message = typeof error?.message === "string" ? error.message.trim() : "unknown JSON-RPC error";
  return message.slice(0, 200);
}

export function parseMcpResponse(body: string): string | undefined {
  const trimmed = body.trim();
  const direct = trimmed ? parsePayload(trimmed) : undefined;
  if (direct) return direct;

  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const parsed = parsePayload(data);
    if (parsed) return parsed;
  }
  return undefined;
}

function parsePayload(payload: string): string | undefined {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const data = JSON.parse(trimmed);
    if (data?.error) throw new Error(`JSON-RPC error: ${errorMessage(data.error)}`);
    const content = data?.result?.content;
    if (!Array.isArray(content)) return undefined;
    const text = content.find((item: McpContentItem) => item?.type === "text" && typeof item.text === "string" && item.text.trim())?.text;
    if (data?.result?.isError) throw new Error(`MCP tool failed: ${(text?.trim() || "provider returned an error").slice(0, 200)}`);
    return text;
  } catch (error) {
    if (error instanceof Error && /^(?:JSON-RPC error|MCP tool failed):/.test(error.message)) throw error;
    return undefined;
  }
}

export async function callMcpTool(options: McpCallOptions): Promise<string> {
  const managedSignal = signalWithTimeout(options.signal, options.timeoutMs);
  try {
    const response = await fetch(options.url, {
      method: "POST",
      signal: managedSignal.signal,
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...options.headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: options.tool,
          arguments: options.arguments,
        },
      }),
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    const bytes = await readResponseBytes(response, options.maxResponseBytes);
    const parsed = parseMcpResponse(new TextDecoder().decode(bytes));
    if (!parsed) throw new Error("Invalid MCP response: missing JSON-RPC text content");
    return parsed;
  } finally {
    managedSignal.dispose();
  }
}
