import { registerSettingsSection, setting, settingsFor } from "pip-common";

export const SETTINGS_ID = "tiny-mcp";

export type ConfigTarget = "pip" | "global" | "project";
export type StderrMode = "ignore" | "tail" | "inherit";
export type ToolPrefix = "server" | "none";
export type TimeoutSetting = "30" | "60" | "120" | "300";
export type ResultLimitSetting = "10000" | "20000" | "40000";

export function registerTinyMcpSettings(): void {
  registerSettingsSection({
    id: SETTINGS_ID,
    title: "Tiny MCP",
    description: "Tiny stdio/HTTP MCP adapter. No OAuth, UI bridge, or SDK dependency refrigerator.",
    order: 80,
    settings: {
      enabled: setting.boolean({ label: "Enabled", default: true, order: 1, requiresReload: true, description: "Enable the tiny stdio/HTTP MCP proxy tool and /tiny-mcp commands." }),
      configTarget: setting.enum({ label: "Config target", default: "pip", choices: ["pip", "global", "project"] as const, order: 2, description: "Default file opened by /tiny-mcp config: PiP-owned, shared global, or project .mcp.json." }),
      metadataCache: setting.boolean({ label: "Metadata cache", default: true, order: 3, description: "Cache tool metadata under ~/.pi/agent/pip so search/list can work before connecting." }),
      defaultTimeout: setting.enum({ label: "Tool timeout", default: "120", choices: ["30", "60", "120", "300"] as const, order: 4, description: "Default MCP request timeout in seconds." }),
      stderr: setting.enum({ label: "Server stderr", default: "tail", choices: ["ignore", "tail", "inherit"] as const, order: 5, requiresReload: true, description: "How to handle MCP server stderr logs." }),
      toolPrefix: setting.enum({ label: "Tool prefix", default: "server", choices: ["server", "none"] as const, order: 6, requiresReload: true, description: "Expose MCP tool names with server prefixes or original names. Collisions are suffixed." }),
      resultLimit: setting.enum({ label: "Result limit", default: "20000", choices: ["10000", "20000", "40000"] as const, order: 7, description: "Maximum text characters shown directly in MCP tool results." }),
    },
  });
}

const scopedSettings = settingsFor(SETTINGS_ID);
export const settingValue = scopedSettings.get;

export function defaultTimeoutMs(): number {
  return Number(settingValue<TimeoutSetting>("defaultTimeout", "120")) * 1000;
}

export function resultLimit(): number {
  return Number(settingValue<ResultLimitSetting>("resultLimit", "20000"));
}
