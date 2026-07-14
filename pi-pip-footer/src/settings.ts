import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettingsSection, setting } from "pip-common";
import { FOOTER_SETTINGS_ID } from "./constants.ts";

export function registerFooterSettings(pi: ExtensionAPI): void {
  registerSettingsSection(pi, {
    id: FOOTER_SETTINGS_ID,
    title: "Pip Footer",
    description: "Pip footer with quotas, context, model, and the existing above-editor token counter.",
    order: 20,
    settings: {
      enabled: setting.boolean({ label: "Enabled", default: true, order: 1, requiresReload: true, description: "Show the pip footer and manage its above-editor token counter." }),
      quotaProvider: setting.enum({
        label: "Quota provider",
        default: "auto",
        choices: ["auto", "codex", "anthropic", "copilot", "off"] as const,
        order: 2,
        description: "Choose which subscription quota source to display, or disable quota checks.",
      }),
      showContext: setting.boolean({ label: "Context bar", default: true, order: 3, description: "Show current context-window usage as a compact progress bar." }),
      showModel: setting.boolean({ label: "Model", default: true, order: 4, description: "Show the active model and thinking level in the lower footer." }),
      showTokenCounter: setting.boolean({ label: "Above-editor token counter", default: true, order: 5, description: "Show live token burn and settled token totals above the editor." }),
      showTokenCost: setting.boolean({ label: "Token counter cost", default: true, order: 6, description: "Show estimated cost in the above-editor token counter." }),
      cacheIcon: setting.enum({ label: "Cache icon", default: "↻", choices: ["↻", "c", "▣", "◫", "□"] as const, order: 7, description: "Glyph used for cache read/write token counts in the token counter." }),
      showCacheHitRate: setting.boolean({ label: "Cache hit rate", default: true, order: 8, description: "Show the latest prompt cache hit rate next to the cache token count." }),
      showPluginLines: setting.boolean({ label: "Plugin lines", default: true, order: 9, description: "Allow other pip plugins to contribute extra lines to the footer." }),
      showGit: setting.boolean({ label: "Git", default: false, order: 10, description: "Show the current git branch when one is available." }),
      showCwd: setting.enum({ label: "CWD", default: "project", choices: ["off", "project", "path"] as const, order: 11, description: "Show no working directory, the project name, or the full path." }),
    },
  });
}
