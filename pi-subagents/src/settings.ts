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
      enabled: setting.boolean({ label: "Enabled", default: true, order: 1, description: "Enable the subagent tool, command, shortcut, and managed run cleanup." }),
      ephemeralTtlMinutes: setting.number({ label: "Ephemeral TTL", default: 30, min: 1, max: 1440, step: 1, order: 2, description: "Minutes to retain completed/interrupted non-kept subagents for read/view inspection." }),
      maxRecentPerParent: setting.number({ label: "Max recent", default: 20, min: 1, max: 200, step: 1, order: 3, description: "Maximum non-kept subagents retained per parent session." }),
      maxRunning: setting.number({ label: "Max running", default: 6, min: 1, max: 50, step: 1, order: 4, description: "Maximum concurrent running subagents in this Pi process." }),
      injectBackgroundResults: setting.boolean({ label: "Inject background results", default: true, order: 5, description: "Send a follow-up message to the original parent session when a background subagent finishes." }),
      alwaysKeep: setting.boolean({ label: "Always keep", default: false, order: 6, description: "Treat new subagents as non-expiring by default unless a tool call explicitly sets keep:false." }),
      showUsageCost: setting.boolean({ label: "Show usage cost", default: true, order: 7, description: "Show estimated cost next to subagent token usage in tool results, status, and view." }),
    },
  });
}

export function subagentSettings(pi: ExtensionAPI) {
  return settingsFor(pi, SETTINGS_ID);
}
