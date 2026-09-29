import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";

type PromptOptions = Pick<BeforeAgentStartEvent["systemPromptOptions"], "sections" | "forceSystemPrompt">;

/**
 * Keep extension instructions in a named section so Pi can persist section changes.
 * An intentional full-prompt override is opaque; instructions must go into that
 * override or Pi would ignore them when rendering the request.
 */
export function setPromptInstructions(options: PromptOptions, section: string, instructions: string): void {
  if (options.forceSystemPrompt !== undefined) {
    options.forceSystemPrompt = [options.forceSystemPrompt, instructions].filter(Boolean).join("\n\n");
  } else {
    options.sections[section] = instructions;
  }
}
