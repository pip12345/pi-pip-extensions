import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configPathForTarget, type ConfigTarget } from "./src/config.ts";
import { openInEditor } from "./src/editor.ts";
import { registerTinyMcpTool, TinyMcpRuntime } from "./src/proxy-tool.ts";
import { registerTinyMcpSettings, tinyMcpSettings } from "./src/settings.ts";

const HELP_TEXT = `Tiny MCP commands:
  /tiny-mcp                         Show all MCP servers and status
  /tiny-mcp status                  Show all MCP servers and status
  /tiny-mcp help                    Show this help
  /tiny-mcp config [pip|global|project]
                                    Open MCP config in $EDITOR/vi
  /tiny-mcp connect [server]        Connect one server or all eligible servers
  /tiny-mcp disconnect [server]     Disconnect one server or all

Config files:
  pip     ~/.pi/agent/pip/tiny-mcp.json
  global  ~/.config/mcp/mcp.json
  project .mcp.json`;

function showOutput(_pi: ExtensionAPI, ctx: any, output: string): void {
  if (ctx.ui?.notify) ctx.ui.notify(output, "info");
  else console.log(output);
}

function managerForContext(runtime: TinyMcpRuntime, ctx: any) {
  return runtime.getManager(ctx?.cwd ?? process.cwd(), { projectTrusted: ctx?.isProjectTrusted?.() === true });
}

async function autoConnectEligible(runtime: TinyMcpRuntime, ctx: any): Promise<void> {
  const manager = managerForContext(runtime, ctx);
  const result = await manager.connectEligible(ctx?.signal);
  if (result.failed.length) ctx.ui?.notify?.(`tiny-mcp failed to connect: ${result.failed.map((failure) => failure.server).join(", ")}. Use /tiny-mcp status for details.`, "warning");
}

export default function tinyMcpExtension(pi: ExtensionAPI) {
  registerTinyMcpSettings(pi);
  const settings = tinyMcpSettings(pi);
  const runtime = new TinyMcpRuntime(settings);
  const unsubscribeSettings = settings.onChange((changes) => {
    if (changes.some((change) => change.key === "enabled" && change.value === false)) void runtime.shutdown();
  });
  if (settings.get("enabled", true)) registerTinyMcpTool(pi, runtime);

  pi.registerCommand("tiny-mcp", {
    description: "Tiny stdio/HTTP MCP status/config/connect commands",
    handler: async (args: string, ctx: any) => {
      if (!settings.get("enabled", true)) return ctx.ui?.notify?.("Tiny MCP is disabled in /pip-settings.", "warning");
      const [subcommand, target] = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const cwd = ctx?.cwd ?? process.cwd();
      try {
        if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
          showOutput(pi, ctx, HELP_TEXT);
          return;
        }
        if (subcommand === "config" || subcommand === "edit") {
          const selected = (target as ConfigTarget | undefined) ?? "pip";
          if (!["pip", "global", "project"].includes(selected)) throw new Error("Usage: /tiny-mcp config [pip|global|project]");
          const path = configPathForTarget(selected, cwd);
          await openInEditor(path);
          await runtime.reset();
          showOutput(pi, ctx, `Edited ${path}`);
          return;
        }
        const manager = managerForContext(runtime, ctx);
        if (subcommand === "connect") {
          if (target) {
            await manager.connect(target, ctx?.signal);
            showOutput(pi, ctx, `Connected ${target}`);
          } else {
            const result = await manager.connectEligible(ctx?.signal);
            const connected = result.connected.length ? `Connected ${result.connected.join(", ")}` : "No eligible MCP servers to connect";
            const failed = result.failed.length ? `\nFailed: ${result.failed.map((failure) => failure.server).join(", ")}` : "";
            showOutput(pi, ctx, `${connected}${failed}`);
          }
          return;
        }
        if (subcommand === "disconnect") {
          await manager.disconnect(target);
          showOutput(pi, ctx, target ? `Disconnected ${target}` : "Disconnected all MCP servers");
          return;
        }
        if (subcommand && subcommand !== "status") {
          ctx.ui?.notify?.(`Unknown /tiny-mcp command: ${subcommand}\n\n${HELP_TEXT}`, "error");
          return;
        }
        const status = `${manager.status()}\n\nUse /tiny-mcp help for commands.`;
        showOutput(pi, ctx, status);
      } catch (error) {
        ctx.ui?.notify?.(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    if (settings.get("enabled", true)) await autoConnectEligible(runtime, ctx);
  });

  pi.on("session_shutdown", async () => {
    unsubscribeSettings();
    await runtime.shutdown();
  });
}

export { executeTinyMcp, TinyMcpRuntime } from "./src/proxy-tool.ts";
export { loadTinyMcpConfig } from "./src/config.ts";
export { TinyMcpManager } from "./src/manager.ts";
