import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerQuestionTool } from "./src/tool.ts";

export default function questionExtension(pi: ExtensionAPI) {
  registerQuestionTool(pi);
}

export { __test } from "./src/tool.ts";
export * from "./src/format.ts";
export * from "./src/state.ts";
