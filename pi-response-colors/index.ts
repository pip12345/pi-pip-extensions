import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderColorTags } from "./src/color-tags.ts";

export const COLOR_OUTPUT_HINT = `The interactive UI supports paired [red]...[/red], [yellow]...[/yellow], [green]...[/green], [cyan]...[/cyan], and [magenta]...[/magenta] color tags. Always close tags and do not nest them. Markdown bold may appear inside a colored span.`;

export function appendColorOutputHint(systemPrompt: string): string {
  return systemPrompt ? `${systemPrompt}\n\n${COLOR_OUTPUT_HINT}` : COLOR_OUTPUT_HINT;
}

export default function responseColorsExtension(pi: ExtensionAPI): void {
  pi.registerMarkdownTransformer((markdown, context) =>
    context.messageType === "assistant" ? renderColorTags(markdown) : markdown,
  );

  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    return { systemPrompt: appendColorOutputHint(event.systemPrompt) };
  });
}

export { renderColorTags } from "./src/color-tags.ts";
