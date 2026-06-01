import { disposePipToolsForPi } from "./src/pip-tools.ts";
import { registerPipSettingsCommand } from "./src/settings-command.ts";

export default function pipCommonExtension(pi: any) {
  registerPipSettingsCommand(pi);
  pi.on("session_shutdown", async () => disposePipToolsForPi(pi));
}

export * from "./src/capabilities.ts";
export * from "./src/content.ts";
export * from "./src/custom-component.ts";
export * from "./src/keys.ts";
export * from "./src/footer-registry.ts";
export * from "./src/lifecycle.ts";
export * from "./src/paths.ts";
export * from "./src/pip-tools.ts";
export * from "./src/prompt-registry.ts";
export * from "./src/quota/index.ts";
export * from "./src/read-only.ts";
export * from "./src/settings.ts";
export * from "./src/settings-command.ts";
export * from "./src/settings-scope.ts";
export * from "./src/session-file.ts";
export * from "./src/pi-api.ts";
export * from "./src/status.ts";
export * from "./src/tui.ts";
export * from "./src/usage.ts";
export * from "./src/widget-restacker.ts";
