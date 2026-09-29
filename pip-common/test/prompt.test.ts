import { describe, expect, it } from "vitest";
import { setPromptInstructions } from "../src/prompt.ts";

describe("prompt instructions", () => {
  it("owns a replaceable section without changing other prompt state", () => {
    const options = { sections: { existing: "other" } as Record<string, string> };
    setPromptInstructions(options, "pip_rules", "first");
    setPromptInstructions(options, "pip_rules", "second");
    expect(options.sections).toEqual({ existing: "other", pip_rules: "second" });
  });

  it("keeps instructions visible after an intentional full-prompt override", () => {
    const options = { sections: {}, forceSystemPrompt: "replacement" };
    setPromptInstructions(options, "pip_guard", "guard");
    setPromptInstructions(options, "pip_colors", "colors");
    expect(options).toEqual({ sections: {}, forceSystemPrompt: "replacement\n\nguard\n\ncolors" });
  });
});
