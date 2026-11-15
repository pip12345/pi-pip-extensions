import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi, emitEvent, runCommand } from "../pip-common/testing.ts";
import { registerProviderProxyExtension, saveProviderProxyConfig } from "./index.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pip-native-proxy-"));
  roots.push(root);
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const pi = createMockPi() as any;
  pi.registerProvider = (provider: string, config: any) => runtime.registerProvider(provider, config);
  pi.unregisterProvider = (provider: string) => runtime.unregisterProvider(provider);
  const configPath = join(root, "proxy.json");
  registerProviderProxyExtension(pi, { configPath });
  return { pi, runtime, configPath, ctx: createMockCtx() };
}

describe("proxy registration through Pi's native runtime", () => {
  it("preserves built-in model metadata while routing and restores it on shutdown", async () => {
    const f = await fixture();
    const original = f.runtime.getModel("openai", "gpt-6.1-sol")!;
    expect(original).toBeDefined();
    await runCommand(f.pi, "proxy", "add openai http://localhost:9000/openai/v1", f.ctx);
    expect(f.runtime.getModel("openai", original.id)).toEqual({ ...original, baseUrl: "http://localhost:9000/openai/v1" });
    expect(f.runtime.getRegisteredProviderConfig("openai")).not.toHaveProperty("models");
    await emitEvent(f.pi, "session_shutdown");
    expect(f.runtime.getRegisteredProviderConfig("openai")).toBeUndefined();
    expect(f.runtime.getModel("openai", original.id)).toEqual(original);
    await f.runtime.settleCredentialWrites();
  });

  it("clears removed OAuth fields instead of retaining Pi's merged registration", async () => {
    const f = await fixture();
    const original = f.runtime.getModel("openai-codex", "gpt-6.1-sol")!;
    await runCommand(f.pi, "proxy", "auth add openai-codex http://localhost:9000/openai-auth", f.ctx);
    await runCommand(f.pi, "proxy", "add openai-codex http://localhost:9000/backend-api", f.ctx);
    expect(f.runtime.getRegisteredProviderConfig("openai-codex")?.oauth).toBeDefined();
    await runCommand(f.pi, "proxy", "auth remove openai-codex", f.ctx);
    const remaining = f.runtime.getRegisteredProviderConfig("openai-codex");
    expect(remaining?.baseUrl).toBe("http://localhost:9000/backend-api");
    expect(remaining?.oauth).toBeUndefined();
    expect(f.runtime.getModel("openai-codex", original.id)).toEqual({ ...original, baseUrl: "http://localhost:9000/backend-api" });
    await runCommand(f.pi, "proxy", "off", f.ctx);
    expect(f.runtime.getRegisteredProviderConfig("openai-codex")).toBeUndefined();
    expect(f.runtime.getModel("openai-codex", original.id)).toEqual(original);
    await f.runtime.settleCredentialWrites();
  });

  it("isolates routing between parent and child native runtimes", async () => {
    const parent = await fixture();
    const child = await fixture();
    saveProviderProxyConfig({ enabled: true, providers: { openai: "http://localhost:9001/v1" }, auth: {} }, parent.configPath);
    await runCommand(parent.pi, "proxy", "status", parent.ctx);
    expect(parent.runtime.getModel("openai", "gpt-6.1-sol")?.baseUrl).toBe("http://localhost:9001/v1");
    expect(child.runtime.getRegisteredProviderConfig("openai")).toBeUndefined();
    await parent.runtime.settleCredentialWrites();
    await child.runtime.settleCredentialWrites();
  });
});
