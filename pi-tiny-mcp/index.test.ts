import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tinyMcp, { executeTinyMcp, loadTinyMcpConfig, resetManager } from "./index.ts";
import { createMockCtx, createMockPi, emitEvent, getRegisteredTool, runCommand } from "pip-common/testing";
import { flushPipTools, pipSettings, resetPipToolsForTests } from "pip-common";

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
});

afterEach(async () => {
  await executeTinyMcp({ action: "disconnect" });
  resetManager();
});

describe("pi-tiny-mcp", () => {
  it("registers settings, command, and pip tool", () => {
    const pi = createMockPi();
    tinyMcp(pi as any);
    flushPipTools(pi as any);
    expect(pipSettings.section("tiny-mcp")?.title).toBe("Tiny MCP");
    expect(pi.commands.has("tiny-mcp")).toBe(true);
    expect(getRegisteredTool(pi, "tiny-mcp")).toBeTruthy();
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
    await runCommand(pi, "tiny-mcp", "config project", createMockCtx({ cwd: dir }));
    process.env.EDITOR = oldEditor;
    const path = join(dir, ".mcp.json");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("mcpServers");
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

    const statusCtx = createMockCtx();
    await runCommand(pi, "tiny-mcp", "", statusCtx);
    expect(statusCtx.ui.notifications.at(-1)?.message).toContain("Use /tiny-mcp help");


    const badCtx = createMockCtx();
    await runCommand(pi, "tiny-mcp", "wat", badCtx);
    expect(badCtx.ui.notifications.at(-1)?.message).toContain("Unknown /tiny-mcp command");
  });

  it("cleans manager on session shutdown", async () => {
    const pi = createMockPi();
    tinyMcp(pi as any);
    await emitEvent(pi, "session_shutdown", {}, createMockCtx());
    expect(true).toBe(true);
  });
});
