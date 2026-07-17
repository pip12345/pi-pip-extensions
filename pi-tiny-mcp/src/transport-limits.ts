export const MAX_MCP_MESSAGE_BYTES = 5 * 1024 * 1024;
export const MAX_MCP_ERROR_BODY_BYTES = 64 * 1024;
export const MAX_MCP_STDERR_LINE_CHARS = 2_000;

function tooLarge(label: string, maxBytes: number): Error {
  return new Error(`${label} exceeded ${maxBytes} byte limit`);
}

export async function readBoundedResponseText(response: Response, maxBytes = MAX_MCP_MESSAGE_BYTES, label = "HTTP MCP response"): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge(label, maxBytes);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(label, maxBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
