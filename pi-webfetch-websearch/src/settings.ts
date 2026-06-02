import { registerSettingsSection, setting, settingsFor } from "../../pip-common/index.ts";

export const SETTINGS_ID = "webfetch-websearch";

export type WebFetchFormat = "markdown" | "text" | "html";
export type WebSearchProviderSetting = "auto" | "exa" | "parallel";
export type MaxBytesSetting = "1MB" | "2MB" | "5MB";
export type MaxCharsSetting = "10000" | "20000" | "40000" | "80000";
export type TimeoutSetting = "10" | "15" | "25" | "30" | "40" | "60";
export type SearchResultsSetting = "5" | "8" | "10";
export type SearchContextSetting = "5000" | "10000" | "20000";
export type ArtifactTtlSetting = "1" | "6" | "24" | "72" | "168";
export type ArtifactMaxSetting = "1" | "10" | "25" | "50" | "100";

export function registerWebSettings(): void {
  registerSettingsSection({
    id: SETTINGS_ID,
    title: "Web Fetch/Search",
    description: "Dependency-free web fetching and no-key web search with cleaned, bounded output.",
    order: 70,
    settings: {
      enabled: setting.boolean({ label: "Enabled", default: true, order: 1, description: "Enable webfetch and websearch tools." }),
      webfetchEnabled: setting.boolean({ label: "Webfetch", default: true, order: 2, description: "Enable the webfetch tool." }),
      websearchEnabled: setting.boolean({ label: "Websearch", default: true, order: 3, description: "Enable the websearch tool." }),
      defaultFormat: setting.enum({ label: "Fetch format", default: "markdown", choices: ["markdown", "text", "html"] as const, order: 4, description: "Output format for webfetch when the tool call does not specify one." }),
      fetchTimeout: setting.enum({ label: "Fetch timeout", default: "30", choices: ["10", "30", "60"] as const, order: 5, description: "Default webfetch request timeout in seconds." }),
      maxBytes: setting.enum({ label: "Fetch max size", default: "5MB", choices: ["1MB", "2MB", "5MB"] as const, order: 6, description: "Maximum downloaded webfetch response size." }),
      maxChars: setting.enum({ label: "Fetch output", default: "20000", choices: ["10000", "20000", "40000", "80000"] as const, order: 7, description: "Default maximum characters returned by webfetch." }),
      upgradeHttp: setting.boolean({ label: "Upgrade HTTP", default: false, order: 8, description: "Rewrite http:// URLs to https:// before fetching." }),
      blockPrivateHosts: setting.boolean({ label: "Block private hosts", default: true, order: 9, description: "Block localhost, private IP literals, and link-local metadata addresses." }),
      searchProvider: setting.enum({ label: "Search provider", default: "auto", choices: ["auto", "parallel", "exa"] as const, order: 10, description: "Provider for websearch. Auto tries Parallel first, then Exa." }),
      searchResults: setting.enum({ label: "Search results", default: "8", choices: ["5", "8", "10"] as const, order: 11, description: "Default number of websearch results requested when supported by the provider." }),
      searchContext: setting.enum({ label: "Search context", default: "10000", choices: ["5000", "10000", "20000"] as const, order: 12, description: "Default maximum characters returned by websearch." }),
      searchTimeout: setting.enum({ label: "Search timeout", default: "25", choices: ["15", "25", "40"] as const, order: 13, description: "Default websearch provider timeout in seconds." }),
      artifactTtlHours: setting.enum({ label: "Artifact TTL", default: "24", choices: ["1", "6", "24", "72", "168"] as const, order: 14, description: "Hours to retain saved webfetch/websearch artifact files per session." }),
      artifactMaxPerSession: setting.enum({ label: "Max artifacts", default: "50", choices: ["1", "10", "25", "50", "100"] as const, order: 15, description: "Maximum saved web artifacts retained per session before deleting oldest unpinned files." }),
    },
  });
}

const scopedSettings = settingsFor(SETTINGS_ID);
export const settingValue = scopedSettings.get;
