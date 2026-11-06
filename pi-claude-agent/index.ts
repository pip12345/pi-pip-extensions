import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ClaudeRuntime } from "./src/runtime.ts";
import { createClaudeProvider } from "./src/provider.ts";
import { executable, MINIMUM_VERSION } from "./src/sdk.ts";

export default function claudeAgent(pi: ExtensionAPI): void {
  let cwd = process.cwd();
  const runtime = new ClaudeRuntime({ cwd: () => cwd });
  pi.registerProvider(createClaudeProvider(runtime, () => cwd));
  pi.on("session_start", (_event, ctx) => { cwd = ctx.cwd; runtime.setCwd(cwd); });
  pi.on("session_shutdown", () => runtime.close());
  pi.on("agent_end", () => runtime.idle());

  pi.registerCommand("claude-agent", {
    description: "Inspect Claude Agent setup",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command !== "status") { ctx.ui.notify("Usage: /claude-agent [status]", "error"); return; }
      const path = executable();
      ctx.ui.notify([
        `Claude Agent executable: ${path ?? "not found"}`,
        `Requires Claude Code ${MINIMUM_VERSION}+ on this machine. Set PI_CLAUDE_PATH to use a specific executable.`,
        "Sign in using `claude auth login`, then select a claude-agent model with /model.",
        "Pi does not read Claude Code credentials. Anthropic approval for OpenCode does not establish approval for Pi subscription use.",
      ].join("\n"), path ? "info" : "warning");
    },
  });
}
