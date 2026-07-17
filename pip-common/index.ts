import { registerPipSettingsCommand } from "./src/settings-command.ts";
import { getPipSettingsRegistry } from "./src/settings.ts";
import { piRuntimeKey } from "./src/runtime.ts";

const SETTINGS_COMMAND_RUNTIMES_KEY = Symbol.for("pip-common.settings-command.runtimes");

function commandRuntimes(): WeakSet<object> {
  const globalState = globalThis as any;
  if (!globalState[SETTINGS_COMMAND_RUNTIMES_KEY]) globalState[SETTINGS_COMMAND_RUNTIMES_KEY] = new WeakSet<object>();
  return globalState[SETTINGS_COMMAND_RUNTIMES_KEY];
}

export default function pipCommonExtension(pi: any) {
  const key = piRuntimeKey(pi);
  if (commandRuntimes().has(key)) return;
  commandRuntimes().add(key);
  registerPipSettingsCommand(pi, getPipSettingsRegistry(pi));
  pi.on("session_shutdown", async () => commandRuntimes().delete(key));
}

export * from "./src/content.ts";
export * from "./src/custom-component.ts";
export * from "./src/keys.ts";
export * from "./src/footer-registry.ts";
export * from "./src/lifecycle.ts";
export * from "./src/paths.ts";
export * from "./src/pip-tools.ts";
export * from "./src/provider-overrides.ts";
export * from "./src/quota/index.ts";
export * from "./src/runtime.ts";
export * from "./src/settings.ts";
export * from "./src/settings-command.ts";
export * from "./src/settings-scope.ts";
export * from "./src/session-file.ts";
export * from "./src/scroll.ts";
export * from "./src/pi-api.ts";
export * from "./src/tui.ts";
export * from "./src/usage.ts";
export * from "./src/temporary-live-models-dev-pricing.ts";
export * from "./src/text-width.ts";
export * from "./src/widget-restacker.ts";
