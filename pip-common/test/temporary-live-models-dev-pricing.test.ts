import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("temporary live models.dev pricing", () => {
  it("aborts a stalled pricing request after the bounded deadline", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }));
    const { applyTemporaryLiveModelsDevCostFallback } = await import("../src/temporary-live-models-dev-pricing.ts");
    const pending = applyTemporaryLiveModelsDevCostFallback({ provider: "github-copilot", model: "test", usage: { input: 100 } });

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toBe(false);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("retries a failed fetch after the short failure expiry", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ "github-copilot": { models: { test: { cost: { input: 2 } } } } })));
    vi.stubGlobal("fetch", fetchMock);
    const { applyTemporaryLiveModelsDevCostFallback } = await import("../src/temporary-live-models-dev-pricing.ts");
    const message = () => ({ provider: "github-copilot", model: "test", usage: { input: 1_000_000, cost: { total: 0 } } });

    await expect(applyTemporaryLiveModelsDevCostFallback(message())).resolves.toBe(false);
    await expect(applyTemporaryLiveModelsDevCostFallback(message())).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    const retried = message();
    await expect(applyTemporaryLiveModelsDevCostFallback(retried)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("applies fetched pricing and clears the timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ "github-copilot": { models: { test: { cost: { input: 2, output: 4 } } } } }))));
    const { applyTemporaryLiveModelsDevCostFallback } = await import("../src/temporary-live-models-dev-pricing.ts");
    const message = { provider: "github-copilot", model: "test", usage: { input: 1_000_000, output: 500_000, cost: { total: 0 } } };

    await expect(applyTemporaryLiveModelsDevCostFallback(message)).resolves.toBe(true);

    expect(message.usage.cost.total).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
  });
});
