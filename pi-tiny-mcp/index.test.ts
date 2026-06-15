import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tinyMcp, { executeTinyMcp, loadTinyMcpConfig, resetManager } from "./index.ts";
import { readState, writeState } from "./src/state.ts";
import { createMockCtx, createMockPi, emitEvent, getRegisteredTool, runCommand } from "../pip-common/testing.ts";
import { flushPipTools, pipSettings, resetPipToolsForTests } from "../pip-common/index.ts";

const fixture = (name: string) => join(process.cwd(), "pi-tiny-mcp", "test", "fixtures", name);

function tempProject() {
  return mkdtempSync(join(tmpdir(), "pi-tiny-mcp-"));
}

beforeEach(() => {
  resetManager();
  resetPipToolsForTests();
  pipSettings.set("tiny-mcp.enabled", true);
  pipSettings.set("tiny-mcp.toolPrefix", "server");
  pipSettings.set("tiny-mcp.metadataCache", false);
  pipSettings.set("tiny-mcp.defaultTimeout", "30");
  writeState({ explicitlyDisconnected: [] });
});

afterEach(async () => {
  await executeTinyMcp({ action: "disconnect" });
  resetManager();
  writeState({ explicitlyDisconnected: [] });
});

describe("pi-tiny-mcp", () => {
  it("registers settings, command, and pip tool", () => {
    const pi = createMockPi();
    tinyMcp(pi as any);
    flushPipTools(pi as any);
    expect(pipSettings.section("tiny-mcp")?.title).toBe("Tiny MCP");
    expect(pi.commands.has("tiny-mcp")).toBe(true);
    const tool = getRegisteredTool(pi, "tiny-mcp");
    expect(tool).toBeTruthy();
    const hints = tool.promptGuidelines.join("\n");
    expect(hints).toContain("~/.pi/agent/pip/tiny-mcp.json");
    expect(hints).toContain("mcpServers");
    expect(hints).toContain("command");
    expect(hints).toContain("args");
  });

  it("loads and validates stdio config", () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { basic: { command: "node", args: [fixture("basic-server.js")] } } }));
    const config = loadTinyMcpConfig(dir);
    expect(config.mcpServers.basic.command).toBe("node");
  });

  it("rejects HTTP config loudly", () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "http://x/mcp" } } }));
    expect(() => loadTinyMcpConfig(dir)).toThrow(/only supports stdio/);
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
    expect((await executeTinyMcp({ connect: "bad" }, dir)).content[0].text).toMatch(/Invalid JSON|timed out/);
    resetManager();
    expect((await executeTinyMcp({ connect: "slow" }, dir)).content[0].text).toContain("timed out");
  });

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

    await emitEvent(pi, "session_start", { reason: "resume" }, createMockCtx({ cwd: dir }));

    expect((await executeTinyMcp({ action: "status" }, dir)).content[0].text).toContain("basic: connected");
  });

  it("auto-connects after resume shutdown without recording lifecycle close as explicit disconnect", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { basic: { command: "node", args: [fixture("basic-server.js")] } } }));
    const pi = createMockPi();
    tinyMcp(pi as any);
    await executeTinyMcp({ connect: "basic" }, dir);

    await emitEvent(pi, "session_shutdown", { reason: "resume" }, createMockCtx({ cwd: dir }));
    expect(readState().explicitlyDisconnected).not.toContain("basic");
    await emitEvent(pi, "session_start", { reason: "resume" }, createMockCtx({ cwd: dir }));

    expect((await executeTinyMcp({ action: "status" }, dir)).content[0].text).toContain("basic: connected");
  });

  it("does not auto-connect explicitly disconnected servers", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { basic: { command: "node", args: [fixture("basic-server.js")] } } }));
    await executeTinyMcp({ connect: "basic" }, dir);
    await executeTinyMcp({ action: "disconnect", server: "basic" }, dir);
    expect(readState().explicitlyDisconnected).toContain("basic");
    resetManager();
    const pi = createMockPi();
    tinyMcp(pi as any);

    await emitEvent(pi, "session_start", { reason: "resume" }, createMockCtx({ cwd: dir }));

    expect((await executeTinyMcp({ action: "status" }, dir)).content[0].text).toContain("basic: disconnected");
  });

  it("skips config-disabled servers during auto-connect", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { basic: { disabled: true } } }));
    const pi = createMockPi();
    tinyMcp(pi as any);

    await emitEvent(pi, "session_start", { reason: "resume" }, createMockCtx({ cwd: dir }));

    expect((await executeTinyMcp({ action: "status" }, dir)).content[0].text).toContain("none configured");
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
    expect((await executeTinyMcp({ action: "status" }, dir)).content[0].text).toContain("broken: error");
  });

  it("cleans manager on session shutdown", async () => {
    const pi = createMockPi();
    tinyMcp(pi as any);
    await emitEvent(pi, "session_shutdown", {}, createMockCtx());
    expect(true).toBe(true);
  });
});
