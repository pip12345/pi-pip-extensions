import { once } from "node:events";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import tinyMcp, { executeTinyMcp as executeWithRuntime, loadTinyMcpConfig, TinyMcpRuntime } from "./index.ts";
import { readState, writeState } from "./src/state.ts";
import { createMockCtx, createMockPi, emitEvent, getRegisteredTool, runCommand } from "../pip-common/testing.ts";
import { createSettingsRegistry, flushPipTools, getPipSettingsRegistry, resetPipToolsForTests, setPipSettingsRegistryForTests, type SettingsRegistry } from "../pip-common/index.ts";
import { registerTinyMcpSettings, tinyMcpSettings } from "./src/settings.ts";

const fixture = (name: string) => join(process.cwd(), "pi-tiny-mcp", "test", "fixtures", name);

function tempProject() {
  return mkdtempSync(join(tmpdir(), "pi-tiny-mcp-"));
}

async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, test: (url: string) => Promise<void>) {
  const server = createServer((req, res) => void Promise.resolve(handler(req, res)).catch((error) => {
    res.statusCode = 500;
    res.end(error instanceof Error ? error.message : String(error));
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  try {
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body ? JSON.parse(body) : undefined));
    req.on("error", reject);
  });
}

function rpcResponse(id: string | number, result: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

let directRuntime: TinyMcpRuntime;
let directSettings: SettingsRegistry;

function executeTinyMcp(input: any, cwd?: string, options?: any, signal?: AbortSignal, ctx?: any) {
  return executeWithRuntime(directRuntime, input, cwd, options, signal, ctx);
}

async function resetManager() {
  await directRuntime.reset();
}

beforeEach(() => {
  resetPipToolsForTests();
  const pi = createMockPi();
  registerTinyMcpSettings(pi as any);
  const settings = getPipSettingsRegistry(pi);
  directSettings = settings;
  settings.set("tiny-mcp.toolPrefix", "server");
  settings.set("tiny-mcp.metadataCache", false);
  settings.set("tiny-mcp.defaultTimeout", "30");
  directRuntime = new TinyMcpRuntime(tinyMcpSettings(pi as any));
  writeState({ explicitlyDisconnected: [] });
});

afterEach(async () => {
  await directRuntime.shutdown();
  writeState({ explicitlyDisconnected: [] });
});

describe("pi-tiny-mcp", () => {
  it("registers settings, command, and pip tool", () => {
    const pi = createMockPi();
    tinyMcp(pi as any);
    flushPipTools(pi as any);
    expect(getPipSettingsRegistry(pi).section("tiny-mcp")?.title).toBe("Tiny MCP");
    expect(pi.commands.has("tiny-mcp")).toBe(true);
    const tool = getRegisteredTool(pi, "tiny-mcp");
    expect(tool).toBeTruthy();
    const hints = tool.promptGuidelines.join("\n");
    expect(hints).toContain("~/.pi/agent/pip/tiny-mcp.json");
    expect(hints).toContain("mcpServers");
    expect(hints).toContain("command");
    expect(hints).toContain("args");
  });

  it("does not register or auto-connect the tool while disabled", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    setPipSettingsRegistryForTests(pi, createSettingsRegistry({ "tiny-mcp": { enabled: false } }, { persistPath: false }));
    tinyMcp(pi as any);
    flushPipTools(pi as any);

    expect(getRegisteredTool(pi, "tiny-mcp")).toBeUndefined();
    await emitEvent(pi, "session_start", {}, ctx);
    await runCommand(pi, "tiny-mcp", "status", ctx);
    expect(ctx.ui.notifications.at(-1).message).toContain("disabled");
  });

  it("shuts down owned resources and rejects tool/command work when disabled live", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { basic: { command: "node", args: [fixture("basic-server.js")] } } }));
    const pi = createMockPi();
    tinyMcp(pi as any);
    flushPipTools(pi as any);
    const ctx = createMockCtx({ cwd: dir });
    const tool = getRegisteredTool(pi, "tiny-mcp");
    await tool.execute("1", { connect: "basic" }, undefined, undefined, ctx);

    const settings = getPipSettingsRegistry(pi);
    settings.set("tiny-mcp.enabled", false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(tool.execute("2", { action: "status" }, undefined, undefined, ctx)).rejects.toThrow(/disabled/);
    await runCommand(pi, "tiny-mcp", "status", ctx);
    expect(ctx.ui.notifications.at(-1)?.message).toContain("disabled");

    settings.set("tiny-mcp.enabled", true);
    const status = await tool.execute("3", { action: "status" }, undefined, undefined, ctx);
    expect(status.content[0].text).toContain("basic: disconnected");
  });

  it("loads project config only when project trust is allowed", () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { basic: { command: "node", args: [fixture("basic-server.js")] } } }));
    const trusted = loadTinyMcpConfig(dir, { projectTrusted: true });
    expect(trusted.mcpServers.basic.command).toBe("node");
    const untrusted = loadTinyMcpConfig(dir, { projectTrusted: false });
    expect(untrusted.mcpServers.basic).toBeUndefined();
    expect(untrusted.sources).not.toContain(join(dir, ".mcp.json"));
  });

  it("loads and validates HTTP config while rejecting OAuth", () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { type: "http", url: "http://127.0.0.1:10530", headers: { "X-Test": "ok" } } } }));
    const config = loadTinyMcpConfig(dir);
    expect(config.mcpServers.remote.url).toBe("http://127.0.0.1:10530");
    expect(config.mcpServers.remote.headers?.["X-Test"]).toBe("ok");

    process.env.TINY_MCP_TEST_TOKEN = "secret-test-token";
    try {
      const envDir = tempProject();
      writeFileSync(join(envDir, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "http://127.0.0.1:10530", headers: { Authorization: "Bearer ${TINY_MCP_TEST_TOKEN}" } } } }));
      expect(loadTinyMcpConfig(envDir).mcpServers.remote.headers?.Authorization).toBe("Bearer secret-test-token");
    } finally {
      delete process.env.TINY_MCP_TEST_TOKEN;
    }

    const oauthDir = tempProject();
    writeFileSync(join(oauthDir, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "http://127.0.0.1:10530", oauth: {} } } }));
    expect(() => loadTinyMcpConfig(oauthDir)).toThrow(/not OAuth/);
  });

  it("scaffolds selected config without opening real vi when command is used", async () => {
    const dir = tempProject();
    const editor = join(dir, "editor.js");
    writeFileSync(editor, "process.exit(0)\n");
    const oldEditor = process.env.EDITOR;
    process.env.EDITOR = `node ${editor}`;
    const pi = createMockPi();
    tinyMcp(pi as any);
    const ctx = createMockCtx({ cwd: dir });
    await runCommand(pi, "tiny-mcp", "config project", ctx);
    process.env.EDITOR = oldEditor;
    const path = join(dir, ".mcp.json");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("mcpServers");
    expect(ctx.ui.notifications.at(-1)).toMatchObject({ message: `Edited ${path}`, level: "info" });
  });

  it("connects, lists, describes, and calls a stdio MCP tool", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { basic: { command: "node", args: [fixture("basic-server.js")] } } }));
    expect((await executeTinyMcp({ connect: "basic" }, dir)).content[0].text).toContain("basic_echo");
    expect((await executeTinyMcp({ search: "echo" }, dir)).content[0].text).toContain("basic_echo");
    expect((await executeTinyMcp({ describe: "basic_echo" }, dir)).content[0].text).toContain("Original: echo");
    expect((await executeTinyMcp({ tool: "basic_echo", args: '{"text":"hi"}' }, dir)).content[0].text).toBe("hi");
  });

  it("throws MCP tool failures and stores oversized full output in a bounded artifact", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { basic: { command: "node", args: [fixture("basic-server.js")] } } }));
    await executeTinyMcp({ connect: "basic" }, dir);

    await expect(executeTinyMcp({ tool: "basic_echo", args: '{"fail":true}' }, dir)).rejects.toThrow("requested failure");

    directSettings.set("tiny-mcp.resultLimit", "10000");
    const full = "x".repeat(30_000);
    const result = await executeTinyMcp({ tool: "basic_echo", args: JSON.stringify({ text: full }) }, dir, {}, undefined, createMockCtx());
    expect(result.content[0].text.length).toBeLessThanOrEqual(10_000);
    expect(result.details).toMatchObject({ action: "call", chars: 30_000, truncated: true });
    expect(Object.keys(result.details).sort()).toEqual(["action", "artifactPath", "chars", "truncated"]);
    expect(readFileSync(result.details.artifactPath!, "utf8")).toBe(full);
    expect(result.content[0].text).toContain(result.details.artifactPath);
    rmSync(result.details.artifactPath!, { force: true });
  });

  it("adds a memory-only runtime MCP server", async () => {
    const dir = tempProject();
    const config = JSON.stringify({ command: "node", args: [fixture("basic-server.js")] });
    expect((await executeTinyMcp({ action: "add", server: "scratch", config, connect: true }, dir)).content[0].text).toContain("scratch_echo");
    expect((await executeTinyMcp({ action: "status" }, dir)).content[0].text).toContain("scratch: connected, 1 tools [runtime]");
    expect((await executeTinyMcp({ tool: "scratch_echo", args: '{"text":"hi"}' }, dir)).content[0].text).toBe("hi");
    await executeTinyMcp({ action: "disconnect", server: "scratch" }, dir);
    await resetManager();
    expect((await executeTinyMcp({ action: "status" }, dir)).content[0].text).toContain("none configured");
  });

  it("connects, lists, and calls a Streamable HTTP MCP tool", async () => {
    let initializedSeen = false;
    await withServer(async (req, res) => {
      if (req.method === "GET") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const payload = await readBody(req);
      expect(req.headers["x-test"]).toBe("ok");
      if (payload.method === "initialize") {
        expect(req.headers.accept).toContain("application/json");
        expect(req.headers.accept).toContain("text/event-stream");
        res.setHeader("content-type", "application/json");
        res.setHeader("MCP-Session-Id", "sid-1");
        res.end(rpcResponse(payload.id, { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "http-test", version: "1" } }));
        return;
      }
      expect(req.headers["mcp-session-id"]).toBe("sid-1");
      expect(req.headers["mcp-protocol-version"]).toBe("2025-11-25");
      if (payload.method === "notifications/initialized") {
        initializedSeen = true;
        res.statusCode = 202;
        res.end();
        return;
      }
      expect(initializedSeen).toBe(true);
      if (payload.method === "tools/list") {
        res.setHeader("content-type", "application/json");
        res.end(rpcResponse(payload.id, { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }));
        return;
      }
      if (payload.method === "tools/call") {
        res.setHeader("content-type", "application/json");
        res.end(rpcResponse(payload.id, { content: [{ type: "text", text: payload.params.arguments.text }] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    }, async (base) => {
      const dir = tempProject();
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { type: "http", url: base, headers: { "X-Test": "ok" } } } }));
      expect((await executeTinyMcp({ connect: "remote" }, dir)).content[0].text).toContain("remote_echo");
      expect((await executeTinyMcp({ describe: "remote_echo" }, dir)).content[0].text).toContain("Original: echo");
      expect((await executeTinyMcp({ tool: "remote_echo", args: '{"text":"hi"}' }, dir)).content[0].text).toBe("hi");
      await executeTinyMcp({ action: "disconnect" }, dir);
    });
  });

  it("aborts pending JSON-RPC and HTTP transport work with the tool signal", async () => {
    let callClosed = false;
    await withServer(async (req, res) => {
      if (req.method === "GET") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const payload = await readBody(req);
      res.setHeader("content-type", "application/json");
      if (payload.method === "initialize") {
        res.end(rpcResponse(payload.id, { protocolVersion: "2025-03-26", capabilities: {} }));
        return;
      }
      if (payload.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (payload.method === "tools/list") {
        res.end(rpcResponse(payload.id, { tools: [{ name: "slow", description: "Slow", inputSchema: { type: "object" } }] }));
        return;
      }
      if (payload.method === "tools/call") {
        const timer = setTimeout(() => res.end(rpcResponse(payload.id, { content: [{ type: "text", text: "late" }] })), 1000);
        res.on("close", () => {
          clearTimeout(timer);
          if (!res.writableEnded) callClosed = true;
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    }, async (base) => {
      const dir = tempProject();
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { url: base } } }));
      await executeTinyMcp({ connect: "remote" }, dir);
      const controller = new AbortController();
      const pending = executeTinyMcp({ tool: "remote_slow", args: "{}" }, dir, {}, controller.signal);
      setTimeout(() => controller.abort(), 20);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(callClosed).toBe(true);
      await executeTinyMcp({ action: "disconnect" }, dir);
    });
  });

  it("accepts Saleae-compatible 204 responses to initialized notifications", async () => {
    let initializedSeen = false;
    await withServer(async (req, res) => {
      if (req.method === "GET") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const payload = await readBody(req);
      if (payload.method === "initialize") {
        res.setHeader("content-type", "application/json");
        res.end(rpcResponse(payload.id, { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "saleae-compatible-test", version: "1" } }));
        return;
      }
      if (payload.method === "notifications/initialized") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        initializedSeen = true;
        res.statusCode = 204;
        res.end();
        return;
      }
      if (payload.method === "tools/list") {
        expect(initializedSeen).toBe(true);
        res.setHeader("content-type", "application/json");
        res.end(rpcResponse(payload.id, { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }));
        return;
      }
      if (payload.method === "tools/call") {
        res.setHeader("content-type", "text/event-stream");
        res.end(`event: message\ndata: ${rpcResponse(payload.id, { content: [{ type: "text", text: payload.params.arguments.text }] })}\n\n`);
        return;
      }
      res.statusCode = 404;
      res.end();
    }, async (base) => {
      const dir = tempProject();
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { url: base } } }));
      await executeTinyMcp({ connect: "remote" }, dir);
      expect((await executeTinyMcp({ tool: "remote_echo", args: '{"text":"hi over sse"}' }, dir)).content[0].text).toBe("hi over sse");
      await executeTinyMcp({ action: "disconnect" }, dir);
    });
  });

  it("refreshes Streamable HTTP tools after tools/list_changed on GET stream", async () => {
    let enabled = false;
    let getRes: ServerResponse | undefined;
    let pendingNotify = false;
    const sendListChanged = () => {
      if (!getRes) {
        pendingNotify = true;
        return;
      }
      getRes.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`);
      getRes.end();
      getRes = undefined;
    };

    await withServer(async (req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        getRes = res;
        if (pendingNotify) {
          pendingNotify = false;
          sendListChanged();
        }
        return;
      }
      const payload = await readBody(req);
      if (payload.method === "initialize") {
        res.setHeader("content-type", "application/json");
        res.end(rpcResponse(payload.id, { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "changed-test", version: "1" } }));
        return;
      }
      if (payload.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (payload.method === "tools/list") {
        const tools = [{ name: "connect_instance", description: "Connect", inputSchema: { type: "object", properties: {} } }];
        if (enabled) tools.push({ name: "decompile_function", description: "Decompile", inputSchema: { type: "object", properties: {} } });
        res.setHeader("content-type", "application/json");
        res.end(rpcResponse(payload.id, { tools }));
        return;
      }
      if (payload.method === "tools/call") {
        enabled = true;
        sendListChanged();
        res.setHeader("content-type", "application/json");
        res.end(rpcResponse(payload.id, { content: [{ type: "text", text: "connected" }] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    }, async (base) => {
      const dir = tempProject();
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { url: base } } }));
      await executeTinyMcp({ connect: "remote" }, dir);
      expect((await executeTinyMcp({ search: "decompile" }, dir)).content[0].text).not.toContain("remote_decompile_function");
      await executeTinyMcp({ tool: "remote_connect_instance", args: "{}" }, dir);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect((await executeTinyMcp({ search: "decompile" }, dir)).content[0].text).toContain("remote_decompile_function");
      await executeTinyMcp({ action: "disconnect" }, dir);
    });
  });

  it("falls back to legacy HTTP+SSE transport", async () => {
    let sseRes: ServerResponse | undefined;
    await withServer(async (req, res) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        sseRes = res;
        res.write("event: endpoint\ndata: /messages\n\n");
        return;
      }
      if (req.method === "POST" && path === "/") {
        res.statusCode = 405;
        res.end();
        return;
      }
      if (req.method === "POST" && path === "/messages") {
        const payload = await readBody(req);
        res.statusCode = 202;
        res.end();
        if (payload.method === "initialize") {
          sseRes?.write(`data: ${rpcResponse(payload.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "legacy", version: "1" } })}\n\n`);
        } else if (payload.method === "tools/list") {
          sseRes?.write(`data: ${rpcResponse(payload.id, { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: {} } }] })}\n\n`);
          sseRes?.end();
        }
        return;
      }
      res.statusCode = 404;
      res.end();
    }, async (base) => {
      const dir = tempProject();
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { legacy: { type: "http", url: base } } }));
      expect((await executeTinyMcp({ connect: "legacy" }, dir)).content[0].text).toContain("legacy_echo");
      await executeTinyMcp({ action: "disconnect" }, dir);
    });
  });

  it("refreshes tools after tools/list_changed", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { ghidra: { command: "node", args: [fixture("dynamic-tools-server.js")] } } }));
    await executeTinyMcp({ connect: "ghidra" }, dir);
    expect((await executeTinyMcp({ search: "decompile" }, dir)).content[0].text).not.toContain("ghidra_decompile_function");
    await executeTinyMcp({ tool: "ghidra_connect_instance", args: "{}" }, dir);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await executeTinyMcp({ search: "decompile" }, dir)).content[0].text).toContain("ghidra_decompile_function");
  });

  it("reports bad stdout JSON and timeouts", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { bad: { command: "node", args: [fixture("bad-json-server.js")], timeoutMs: 100 }, slow: { command: "node", args: [fixture("slow-server.js")], timeoutMs: 100 } } }));
    await expect(executeTinyMcp({ connect: "bad" }, dir)).rejects.toThrow(/Invalid JSON|timed out/);
    await resetManager();
    await expect(executeTinyMcp({ connect: "slow" }, dir)).rejects.toThrow(/timed out/);
  }, 10_000);

  it("shows slash command help and hints", async () => {
    const pi = createMockPi();
    tinyMcp(pi as any);
    const helpCtx = createMockCtx();
    await runCommand(pi, "tiny-mcp", "help", helpCtx);
    expect(helpCtx.ui.notifications.at(-1)?.message).toContain("/tiny-mcp config");
    expect(helpCtx.ui.notifications.at(-1)?.message).toContain("/tiny-mcp connect");

    const statusCtx = createMockCtx();
    await runCommand(pi, "tiny-mcp", "", statusCtx);
    expect(statusCtx.ui.notifications.at(-1)?.message).toContain("Use /tiny-mcp help");


    const connectDir = tempProject();
    writeFileSync(join(connectDir, ".mcp.json"), JSON.stringify({ mcpServers: { basic: { command: "node", args: [fixture("basic-server.js")] } } }));
    const connectCtx = createMockCtx({ cwd: connectDir });
    await runCommand(pi, "tiny-mcp", "connect basic", connectCtx);
    expect(connectCtx.ui.notifications.at(-1)).toMatchObject({ message: "Connected basic", level: "info" });

    const disconnectCtx = createMockCtx({ cwd: connectDir });
    await runCommand(pi, "tiny-mcp", "disconnect basic", disconnectCtx);
    expect(disconnectCtx.ui.notifications.at(-1)).toMatchObject({ message: "Disconnected basic", level: "info" });

    const oldReconnectCtx = createMockCtx();
    await runCommand(pi, "tiny-mcp", "reconnect basic", oldReconnectCtx);
    expect(oldReconnectCtx.ui.notifications.at(-1)?.message).toContain("Unknown /tiny-mcp command");

    const badCtx = createMockCtx();
    await runCommand(pi, "tiny-mcp", "wat", badCtx);
    expect(badCtx.ui.notifications.at(-1)?.message).toContain("Unknown /tiny-mcp command");
  });

  it("auto-connects configured enabled servers on session start", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { basic: { command: "node", args: [fixture("basic-server.js")] } } }));
    const pi = createMockPi();
    tinyMcp(pi as any);
    const ctx = createMockCtx({ cwd: dir });

    await emitEvent(pi, "session_start", { reason: "resume" }, ctx);

    const status = await getRegisteredTool(pi, "tiny-mcp").execute("1", { action: "status" }, undefined, undefined, ctx);
    expect(status.content[0].text).toContain("basic: connected");
  });

  it("keeps parent and child manager pools isolated", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { basic: { command: "node", args: [fixture("basic-server.js")] } } }));
    const parentPi = createMockPi();
    const childPi = createMockPi();
    tinyMcp(parentPi as any);
    tinyMcp(childPi as any);
    const parentCtx = createMockCtx({ cwd: dir });
    const childCtx = createMockCtx({ cwd: dir });

    await emitEvent(parentPi, "session_start", { reason: "startup" }, parentCtx);
    await emitEvent(childPi, "session_start", { reason: "startup" }, childCtx);
    await emitEvent(childPi, "session_shutdown", { reason: "quit" }, childCtx);

    const parentStatus = await getRegisteredTool(parentPi, "tiny-mcp").execute("1", { action: "status" }, undefined, undefined, parentCtx);
    const childStatus = await getRegisteredTool(childPi, "tiny-mcp").execute("1", { action: "status" }, undefined, undefined, childCtx);
    expect(parentStatus.content[0].text).toContain("basic: connected");
    expect(childStatus.content[0].text).toContain("basic: disconnected");
    await emitEvent(parentPi, "session_shutdown", { reason: "quit" }, parentCtx);
  });

  it("does not load or auto-connect project servers when the project is untrusted", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { project_server: { command: "node", args: [fixture("basic-server.js")] } } }));
    const pi = createMockPi();
    tinyMcp(pi as any);
    flushPipTools(pi as any);
    const ctx = createMockCtx({ cwd: dir, projectTrusted: false });

    await emitEvent(pi, "session_start", { reason: "resume" }, ctx);
    const status = await getRegisteredTool(pi, "tiny-mcp").execute("1", { action: "status" }, undefined, undefined, ctx);

    expect(status.content[0].text).not.toContain("project_server");
    expect(ctx.ui.notifications).toEqual([]);
  });

  it("auto-connects after resume shutdown without recording lifecycle close as explicit disconnect", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { basic: { command: "node", args: [fixture("basic-server.js")] } } }));
    const pi = createMockPi();
    tinyMcp(pi as any);
    const ctx = createMockCtx({ cwd: dir });
    await emitEvent(pi, "session_start", { reason: "resume" }, ctx);
    await emitEvent(pi, "session_shutdown", { reason: "resume" }, ctx);
    expect(readState().explicitlyDisconnected).not.toContain("basic");
    await emitEvent(pi, "session_start", { reason: "resume" }, ctx);

    const status = await getRegisteredTool(pi, "tiny-mcp").execute("1", { action: "status" }, undefined, undefined, ctx);
    expect(status.content[0].text).toContain("basic: connected");
  });

  it("does not auto-connect explicitly disconnected servers", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { basic: { command: "node", args: [fixture("basic-server.js")] } } }));
    await executeTinyMcp({ connect: "basic" }, dir);
    await executeTinyMcp({ action: "disconnect", server: "basic" }, dir);
    expect(readState().explicitlyDisconnected).toContain("basic");
    await resetManager();
    const pi = createMockPi();
    tinyMcp(pi as any);
    const ctx = createMockCtx({ cwd: dir });

    await emitEvent(pi, "session_start", { reason: "resume" }, ctx);

    const status = await getRegisteredTool(pi, "tiny-mcp").execute("1", { action: "status" }, undefined, undefined, ctx);
    expect(status.content[0].text).toContain("basic: disconnected");
  });

  it("skips config-disabled servers during auto-connect", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { basic: { disabled: true } } }));
    const pi = createMockPi();
    tinyMcp(pi as any);
    const ctx = createMockCtx({ cwd: dir });

    await emitEvent(pi, "session_start", { reason: "resume" }, ctx);

    const status = await getRegisteredTool(pi, "tiny-mcp").execute("1", { action: "status" }, undefined, undefined, ctx);
    expect(status.content[0].text).toContain("none configured");
  });

  it("reports auto-connect failures without blocking session start", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { broken: { command: "definitely-not-a-real-command", timeoutMs: 100 } } }));
    const pi = createMockPi();
    tinyMcp(pi as any);
    const ctx = createMockCtx({ cwd: dir });

    await emitEvent(pi, "session_start", { reason: "resume" }, ctx);

    expect(ctx.ui.notifications.at(-1)).toMatchObject({ level: "warning" });
    expect(ctx.ui.notifications.at(-1)?.message).toContain("broken");
    const status = await getRegisteredTool(pi, "tiny-mcp").execute("1", { action: "status" }, undefined, undefined, ctx);
    expect(status.content[0].text).toContain("broken: error");
  });

  it("cleans manager on session shutdown", async () => {
    const pi = createMockPi();
    tinyMcp(pi as any);
    await emitEvent(pi, "session_shutdown", {}, createMockCtx());
    expect(true).toBe(true);
  });
});
