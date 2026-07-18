import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettingsSection, setting, settingsFor } from "../../pip-common/index.ts";

export const SETTINGS_ID = "webfetch-websearch";

export function registerWebSettings(pi: ExtensionAPI): void {
  registerSettingsSection(pi, {
    id: SETTINGS_ID,
    title: "Web Fetch/Search",
    description: "Dependency-free web fetching and no-key web search with cleaned, bounded output.",
    order: 70,
    settings: {
      webfetchEnabled: setting.boolean({ label: "Webfetch", default: true, order: 1, description: "Enable the webfetch tool." }),
      websearchEnabled: setting.boolean({ label: "Websearch", default: true, order: 2, description: "Enable the websearch tool." }),
      searchProvider: setting.enum({ label: "Search provider", default: "auto", choices: ["auto", "parallel", "exa"] as const, order: 3, description: "Provider for websearch. Auto tries Parallel first, then Exa." }),
    },
  });
}

export function webSettings(pi: ExtensionAPI) {
  return settingsFor(pi, SETTINGS_ID);
}
