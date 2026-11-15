import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockCtx, createMockPi, runCommand } from "../pip-common/testing.ts";
import { loadProviderProxyConfig, registerProviderProxyExtension, saveProviderProxyConfig } from "./index.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const roots: string[] = [];
afterEach(() => {
  vi.mocked(renameSync).mockReset().mockImplementation(realFs.renameSync);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pip-proxy-transaction-"));
  roots.push(root);
  const configPath = join(root, "proxy.json");
  const oldConfig = { enabled: true, providers: { openai: "http://localhost:9000/v1" }, auth: {} };
  saveProviderProxyConfig(oldConfig, configPath);
  const pi = createMockPi() as any;
  const routes = new Map<string, any>();
  // ModelRuntime.registerProvider() merges defined fields, so replacements must
  // clear an owned registration before a field can actually be removed.
  pi.registerProvider = (provider: string, config: any) => { routes.set(provider, { ...routes.get(provider), ...config }); };
  pi.unregisterProvider = (provider: string) => { routes.delete(provider); };
  registerProviderProxyExtension(pi, { configPath });
  return { pi, routes, oldConfig, configPath, root, ctx: createMockCtx() };
}

describe("provider proxy transactions", () => {
  it("restores already-applied providers when a later provider registration fails", async () => {
    const f = fixture();
    await runCommand(f.pi, "proxy", "add anthropic http://localhost:9001/anthropic", f.ctx);
    const beforeRoutes = new Map(f.routes);
    const register = f.pi.registerProvider;
    const operations: string[] = [];
    f.pi.registerProvider = (provider: string, config: any) => {
      operations.push(provider);
      if (provider === "openai" && config.baseUrl === "http://localhost:9002/v1") throw new Error("second provider rejected");
      register(provider, config);
    };
    const before = readFileSync(f.configPath, "utf8");
    await runCommand(f.pi, "proxy", "add openai http://localhost:9002/v1", f.ctx);
    expect(operations.slice(0, 2)).toEqual(["anthropic", "openai"]);
    expect(f.routes).toEqual(beforeRoutes);
    expect(readFileSync(f.configPath, "utf8")).toBe(before);
    expect(f.ctx.ui.notifications.at(-1).message).toContain("second provider rejected");
  });

  it("rolls runtime routing back if the atomic config replacement fails", async () => {
    const f = fixture();
    const before = readFileSync(f.configPath, "utf8");
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("config replacement failed"); });
    await runCommand(f.pi, "proxy", "add openai http://localhost:9001/v1", f.ctx);
    expect(f.routes.get("openai")).toEqual({ baseUrl: f.oldConfig.providers.openai });
    expect(readFileSync(f.configPath, "utf8")).toBe(before);
    expect(readdirSync(f.root)).toEqual(["proxy.json"]);
    expect(f.ctx.ui.notifications.at(-1).message).toContain("config replacement failed");
  });

  it("explicitly reports persistence and rollback failure without changing saved config", async () => {
    const f = fixture();
    const before = readFileSync(f.configPath, "utf8");
    const register = f.pi.registerProvider;
    f.pi.registerProvider = (provider: string, config: any) => {
      if (config.baseUrl === f.oldConfig.providers.openai) throw new Error("old route rejected");
      register(provider, config);
    };
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("config replacement failed"); });
    await runCommand(f.pi, "proxy", "add openai http://localhost:9001/v1", f.ctx);
    expect(readFileSync(f.configPath, "utf8")).toBe(before);
    expect(f.ctx.ui.notifications.at(-1)).toMatchObject({ level: "error", message: expect.stringContaining("persistence and rollback failed") });
  });

  it("reports a registration rollback failure explicitly", async () => {
    const f = fixture();
    f.pi.registerProvider = () => { throw new Error("registration unavailable"); };
    await runCommand(f.pi, "proxy", "add openai http://localhost:9001/v1", f.ctx);
    expect(loadProviderProxyConfig(f.configPath)).toEqual(f.oldConfig);
    expect(f.ctx.ui.notifications.at(-1)).toMatchObject({ level: "error", message: expect.stringContaining("reconciliation and rollback failed") });
  });
});
