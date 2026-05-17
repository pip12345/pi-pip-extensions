import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configPathForTarget } from "./src/config.ts";
import { openInEditor } from "./src/editor.ts";
import { getManager, registerTinyMcpTool, resetManager, shutdownManager } from "./src/proxy-tool.ts";
import { registerTinyMcpSettings, settingValue, type ConfigTarget } from "./src/settings.ts";

registerTinyMcpSettings();

const HELP_TEXT = `Tiny MCP commands:
  /tiny-mcp                         Show all MCP servers and status
  /tiny-mcp status                  Show all MCP servers and status
  /tiny-mcp help                    Show this help
  /tiny-mcp config [pip|global|project]
                                    Open MCP config in $EDITOR/vi
  /tiny-mcp reconnect <server>      Reconnect one server
  /tiny-mcp disconnect [server]     Disconnect one server or all

Config files:
  pip     ~/.pi/agent/pip/tiny-mcp.json
  global  ~/.config/mcp/mcp.json
  project .mcp.json`;

export default function tinyMcpExtension(pi: ExtensionAPI) {
  if (settingValue("enabled", true)) registerTinyMcpTool(pi);

  pi.registerCommand("tiny-mcp", {
    description: "Tiny stdio-only MCP status/config/reconnect commands",
    handler: async (args: string, ctx: any) => {
      const [subcommand, target] = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const cwd = ctx?.cwd ?? process.cwd();
      try {
        if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
          ctx.ui?.notify?.(HELP_TEXT, "info");
          return;
        }
        if (subcommand === "config" || subcommand === "edit") {
          const selected = (target as ConfigTarget | undefined) ?? settingValue<ConfigTarget>("configTarget", "pip");
          if (!["pip", "global", "project"].includes(selected)) throw new Error("Usage: /tiny-mcp config [pip|global|project]");
          const path = configPathForTarget(selected, cwd);
          await openInEditor(path);
          resetManager();
          ctx.ui?.notify?.(`Edited ${path}`, "info");
          return;
        }
        const manager = getManager(cwd);
        if (subcommand === "reconnect") {
          if (target) await manager.disconnect(target);
          else await manager.disconnect();
          if (target) await manager.connect(target);
          ctx.ui?.notify?.(target ? `Reconnected ${target}` : "Disconnected all MCP servers", "info");
          return;
        }
        if (subcommand === "disconnect") {
          await manager.disconnect(target);
          ctx.ui?.notify?.(target ? `Disconnected ${target}` : "Disconnected all MCP servers", "info");
          return;
        }
        if (subcommand && subcommand !== "status") {
          ctx.ui?.notify?.(`Unknown /tiny-mcp command: ${subcommand}\n\n${HELP_TEXT}`, "error");
          return;
        }
        const status = `${manager.status()}\n\nUse /tiny-mcp help for commands.`;
        if (ctx.ui?.notify) ctx.ui.notify(status, "info");
        else console.log(status);
      } catch (error) {
        ctx.ui?.notify?.(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await shutdownManager();
  });
}

export { executeTinyMcp, resetManager, shutdownManager } from "./src/proxy-tool.ts";
export { loadTinyMcpConfig } from "./src/config.ts";
export { TinyMcpManager } from "./src/manager.ts";
