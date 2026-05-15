import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWebSettings } from "./src/settings.ts";
import { registerWebfetchTool } from "./src/webfetch.ts";
import { registerWebsearchTool } from "./src/websearch.ts";

registerWebSettings();

export default function webfetchWebsearchExtension(pi: ExtensionAPI) {
  registerWebfetchTool(pi);
  registerWebsearchTool(pi);
}

export { executeWebFetch } from "./src/webfetch.ts";
export { executeWebSearch } from "./src/websearch.ts";
export { parseMcpResponse } from "./src/mcp.ts";
