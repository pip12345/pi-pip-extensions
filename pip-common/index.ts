import { registerPipSettingsCommand } from "./src/settings-command.ts";

export default function pipCommonExtension(pi: any) {
  registerPipSettingsCommand(pi);
}

export * from "./src/capabilities.ts";
export * from "./src/content.ts";
export * from "./src/custom-component.ts";
export * from "./src/keys.ts";
export * from "./src/lifecycle.ts";
export * from "./src/prompt-registry.ts";
export * from "./src/settings.ts";
export * from "./src/settings-command.ts";
export * from "./src/status.ts";
export * from "./src/tui.ts";
export * from "./src/usage.ts";
