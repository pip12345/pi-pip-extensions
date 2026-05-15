export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5000, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
