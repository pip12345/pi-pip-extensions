export const MAX_TIMEOUT_SECONDS = 120;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_CHARS = 20_000;

export interface ManagedAbortSignal {
  signal: AbortSignal;
  dispose(): void;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

export function formatChars(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(chars % 1_000_000 === 0 ? 0 : 1)}M chars`;
  if (chars >= 1000) return `${(chars / 1000).toFixed(chars % 1000 === 0 ? 0 : 1)}K chars`;
  return `${chars} chars`;
}

export function truncateContent(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const notice = `\n\n[Truncated: showing ${maxChars} of ${text.length} chars]`;
  return { text: text.slice(0, Math.max(0, maxChars - notice.length)).trimEnd() + notice, truncated: true };
}

export function signalWithTimeout(parent: AbortSignal | undefined, timeoutMs: number): ManagedAbortSignal {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
  timer.unref?.();
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  let disposed = false;
  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

export async function readResponseBytes(response: Pick<Response, "body" | "headers">, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Response too large: ${formatBytes(declared)} exceeds ${formatBytes(maxBytes)} limit.`);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(`Response too large: exceeds ${formatBytes(maxBytes)} limit.`);
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
