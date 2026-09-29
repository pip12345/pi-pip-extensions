import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setPromptInstructions } from "../pip-common/index.ts";
import { renderColorTags } from "./src/color-tags.ts";

export const COLOR_OUTPUT_HINT = `The interactive UI supports paired <red>...</red>, <yellow>...</yellow>, <green>...</green>, <cyan>...</cyan>, and <magenta>...</magenta> color tags. Always close tags and do not nest them. Markdown bold may appear inside a colored span.`;

export default function responseColorsExtension(pi: ExtensionAPI): void {
  pi.registerMarkdownTransformer((markdown, context) =>
    context.messageType === "assistant" ? renderColorTags(markdown) : markdown,
  );

  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    setPromptInstructions(event.systemPromptOptions, "pip_response_colors", COLOR_OUTPUT_HINT);
  });
}

export { renderColorTags } from "./src/color-tags.ts";
