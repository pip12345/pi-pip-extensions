import { signalWithTimeout } from "./limits.ts";

export interface McpContentItem {
  type: string;
  text?: string;
}

export interface McpCallOptions {
  url: string;
  tool: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
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
    const content = data?.result?.content;
    if (!Array.isArray(content)) return undefined;
    return content.find((item: McpContentItem) => item?.type === "text" && typeof item.text === "string" && item.text.trim())?.text;
  } catch {
    return undefined;
  }
}

export async function callMcpTool(options: McpCallOptions): Promise<string | undefined> {
  const response = await fetch(options.url, {
    method: "POST",
    signal: signalWithTimeout(options.signal, options.timeoutMs),
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

  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  return parseMcpResponse(await response.text());
}
