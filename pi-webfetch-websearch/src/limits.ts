export const MAX_TIMEOUT_SECONDS = 120;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_CHARS = 20_000;

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

export function signalWithTimeout(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
  timer.unref?.();
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
  }
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}
