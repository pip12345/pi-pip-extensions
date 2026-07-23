import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanupArtifacts } from "./src/artifacts.ts";
import { registerWebSettings, webSettings } from "./src/settings.ts";
import { registerWebfetchTool, type WebFetchPolicy } from "./src/webfetch.ts";
import { registerWebsearchTool } from "./src/websearch.ts";

export interface WebExtensionOptions {
  webfetchPolicy?: WebFetchPolicy;
}

export default function webfetchWebsearchExtension(pi: ExtensionAPI, options: WebExtensionOptions = {}) {
  registerWebSettings(pi);
  const settings = webSettings(pi);
  pi.on?.("session_start", async (_event: any, ctx: any) => cleanupArtifacts(ctx));
  registerWebfetchTool(pi, settings, options.webfetchPolicy);
  registerWebsearchTool(pi, settings);
}

export { executeWebFetch } from "./src/webfetch.ts";
export { executeWebSearch } from "./src/websearch.ts";
export { parseMcpResponse } from "./src/mcp.ts";
