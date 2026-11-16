import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettingsSection, setting, settingsFor } from "../../pip-common/index.ts";

export const SETTINGS_ID = "subagents";

export function registerSubagentSettings(pi: ExtensionAPI): void {
  registerSettingsSection(pi, {
    id: SETTINGS_ID,
    title: "Subagents",
    description: "Minimal quiet child task runs with isolated context.",
    order: 65,
    settings: {
      enabled: setting.boolean({ label: "Enabled", default: true, order: 1, description: "Enable the subagent tools and the /subagent command." }),
      maxRunning: setting.number({ label: "Max running", default: 6, min: 1, max: 50, step: 1, order: 2, description: "Maximum concurrent running subagents in this session." }),
      injectBackgroundResults: setting.boolean({ label: "Inject background results", default: true, order: 3, description: "Send a follow-up message to the original parent session when a background subagent finishes." }),
    },
  });
}

export function subagentSettings(pi: ExtensionAPI) {
  return settingsFor(pi, SETTINGS_ID);
}
