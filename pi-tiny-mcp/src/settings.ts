import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettingsSection, setting, settingsFor } from "../../pip-common/index.ts";

export const SETTINGS_ID = "tiny-mcp";

export function registerTinyMcpSettings(pi: ExtensionAPI): void {
  registerSettingsSection(pi, {
    id: SETTINGS_ID,
    title: "Tiny MCP",
    description: "Tiny stdio/HTTP MCP adapter. No OAuth, UI bridge, or SDK dependency refrigerator.",
    order: 80,
    settings: {
      enabled: setting.boolean({ label: "Enabled", default: true, order: 1, requiresReload: true, description: "Enable the tiny stdio/HTTP MCP proxy tool and /tiny-mcp commands." }),
    },
  });
}

export function tinyMcpSettings(pi: ExtensionAPI) {
  return settingsFor(pi, SETTINGS_ID);
}
