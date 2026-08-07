import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { colorizeAssistantMessage } from "./src/color-tags.ts";

export const COLOR_OUTPUT_HINT = `The interactive UI supports paired [red]...[/red], [yellow]...[/yellow], [green]...[/green], [cyan]...[/cyan], and [magenta]...[/magenta] color tags. Always close tags and do not nest them. Markdown bold may appear inside a colored span.`;

const PATCH_KEY = Symbol.for("pip.pi-response-colors.assistant-message-patch");

type AssistantPrototype = {
  updateContent(message: unknown): void;
};

type PatchRecord = {
  prototype: AssistantPrototype;
  predecessor: AssistantPrototype["updateContent"];
  patched: AssistantPrototype["updateContent"];
  transform(message: unknown): unknown;
};

function currentPatch(): PatchRecord | undefined {
  return Reflect.get(globalThis, PATCH_KEY) as PatchRecord | undefined;
}

export function appendColorOutputHint(systemPrompt: string): string {
  return systemPrompt ? `${systemPrompt}\n\n${COLOR_OUTPUT_HINT}` : COLOR_OUTPUT_HINT;
}

export function installAssistantColorPatch(): PatchRecord {
  const existing = currentPatch();
  if (existing) {
    existing.transform = colorizeAssistantMessage;
    return existing;
  }

  const prototype = AssistantMessageComponent.prototype as unknown as AssistantPrototype;
  const predecessor = prototype.updateContent;
  const record = {
    prototype,
    predecessor,
    patched: (() => undefined) as AssistantPrototype["updateContent"],
    transform: colorizeAssistantMessage as (message: unknown) => unknown,
  };
  record.patched = function updateContentWithColors(this: unknown, message: unknown): void {
    record.predecessor.call(this, record.transform(message));
  };
  prototype.updateContent = record.patched;
  Reflect.set(globalThis, PATCH_KEY, record);
  return record;
}

export function restoreAssistantColorPatch(record: PatchRecord): void {
  if (record.prototype.updateContent !== record.patched) return;
  record.prototype.updateContent = record.predecessor;
  if (currentPatch() === record) Reflect.deleteProperty(globalThis, PATCH_KEY);
}

export default function responseColorsExtension(pi: ExtensionAPI): void {
  const patch = installAssistantColorPatch();

  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    return { systemPrompt: appendColorOutputHint(event.systemPrompt) };
  });

  pi.on("session_shutdown", () => {
    restoreAssistantColorPatch(patch);
  });
}

export { colorizeAssistantMessage, renderColorTags } from "./src/color-tags.ts";
