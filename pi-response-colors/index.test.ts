import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createMockCtx, createMockPi, emitEvent } from "../pip-common/testing.ts";
import responseColors, {
  COLOR_OUTPUT_HINT,
  appendColorOutputHint,
  renderColorTags,
} from "./index.ts";

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[39m";

describe("response color tags", () => {
  it("renders every supported balanced tag and accepts case-insensitive model output", () => {
    expect(renderColorTags("[red]r[/red] [yellow]y[/yellow] [green]g[/green] [cyan]c[/cyan] [MAGENTA]m[/MAGENTA]")).toBe(
      `${RED}r${RESET} ${YELLOW}y${RESET} ${GREEN}g${RESET} ${CYAN}c${RESET} ${MAGENTA}m${RESET}`,
    );
  });

  it("renders XML-style tags and allows both styles in one response", () => {
    expect(renderColorTags("<red>r</RED> <yellow>y</yellow> <green>g</green> <cyan>c</cyan> <MAGENTA>m</magenta> [red]old[/red]")).toBe(
      `${RED}r${RESET} ${YELLOW}y${RESET} ${GREEN}g${RESET} ${CYAN}c${RESET} ${MAGENTA}m${RESET} ${RED}old${RESET}`,
    );
  });

  it.each([
    "<red>outer <yellow>inner</yellow> outer</red>",
    "<red>outer [yellow]inner[/yellow] outer</red>",
    "[red]outer <yellow>inner</yellow> outer[/red]",
  ])("restores outer colors with XML-style or mixed nesting: %s", (source) => {
    expect(renderColorTags(source)).toBe(`${RED}outer ${YELLOW}inner${RED} outer${RESET}`);
  });

  it("restores an outer color when balanced tags are nested", () => {
    expect(renderColorTags("[red]outer [yellow]inner[/yellow] outer[/red]")).toBe(
      `${RED}outer ${YELLOW}inner${RED} outer${RESET}`,
    );
  });

  it("leaves tags in inline code, fenced code, and escaped prose untouched", () => {
    const source = [
      "`[red]inline[/red]` [green]outside[/green] \\[yellow]literal[/yellow]",
      "",
      "```text",
      "[cyan]fenced[/cyan]",
      "```",
    ].join("\n");
    const rendered = renderColorTags(source);

    expect(rendered).toContain("`[red]inline[/red]`");
    expect(rendered).toContain(`${GREEN}outside${RESET}`);
    expect(rendered).toContain("\\[yellow]literal[/yellow]");
    expect(rendered).toContain("[cyan]fenced[/cyan]");
  });

  it("protects XML-style tags in code and escaped prose", () => {
    const source = [
      "`<red>inline</red>` <green>outside</green>",
      "\\<yellow>escaped opener</yellow> <red>escaped closer\\</red>",
      "```xml",
      "<cyan>fenced</cyan>",
      "```",
      "~~~xml",
      "<magenta>fenced</magenta>",
      "~~~",
    ].join("\n");
    expect(renderColorTags(source)).toBe(source.replace("<green>outside</green>", `${GREEN}outside${RESET}`));
  });

  it("leaves unknown, mismatched, and unclosed tags literal", () => {
    for (const source of [
      "[blue]unknown[/blue]",
      "[red]unclosed",
      "orphan[/red]",
      "[red]mismatch[/yellow]",
      "<blue>unknown</blue>",
      "<red>unclosed",
      "orphan</red>",
      "<red>mismatch</yellow>",
      "<red>mixed[/red]",
      "[red]mixed</red>",
      "<red]malformed</red>",
      "[red>malformed[/red]",
      "<red>malformed</red]",
      "[red]malformed[/red>",
      "<red/>self-closing",
      '<red class="warning">attributes</red>',
    ]) {
      expect(renderColorTags(source)).toBe(source);
    }
  });

  it.each([
    "[red]**Bold red emphasis.**[/red]",
    "<red>**Bold red emphasis.**</red>",
  ])("keeps generated color styling intact through Pi's Markdown renderer: %s", (source) => {
    const identity = (text: string) => text;
    const theme: MarkdownTheme = {
      heading: identity,
      link: identity,
      linkUrl: identity,
      code: identity,
      codeBlock: identity,
      codeBlockBorder: identity,
      quote: identity,
      quoteBorder: identity,
      hr: identity,
      listBullet: identity,
      bold: (text) => `\x1b[1m${text}\x1b[22m`,
      italic: identity,
      strikethrough: identity,
      underline: identity,
    };
    const transformed = renderColorTags(source);
    const [line] = new Markdown(transformed, 0, 0, theme).render(80);

    expect(transformed).toBe(`**${RED}Bold red emphasis.${RESET}**`);
    expect(line).toContain(`\x1b[1m${RED}Bold red emphasis.${RESET}\x1b[22m`);
    expect(line).not.toContain("[red]");
    expect(line).not.toContain("<red>");
  });
});

describe("pi-response-colors extension", () => {
  it("registers an assistant-only Markdown transformer and adds its hint only in interactive mode", async () => {
    const pi = createMockPi();
    responseColors(pi as any);

    expect(pi.markdownTransformers).toHaveLength(1);
    const transform = pi.markdownTransformers[0];
    expect(transform("[red]stop[/red]", { messageType: "assistant", isStreaming: false, availableWidth: 80 })).toBe(`${RED}stop${RESET}`);
    for (const isStreaming of [true, false]) {
      expect(transform("<red>stop</red>", { messageType: "assistant", isStreaming, availableWidth: 80 })).toBe(`${RED}stop${RESET}`);
    }
    expect(transform("<red>partial</re", { messageType: "assistant", isStreaming: true, availableWidth: 80 })).toBe("<red>partial</re");
    expect(transform("<red>user</red>", { messageType: "user", isStreaming: false, availableWidth: 80 })).toBe("<red>user</red>");
    expect(transform("<red>thought</red>", { messageType: "assistant-thinking", isStreaming: false, availableWidth: 80 })).toBe("<red>thought</red>");
    expect(transform("[red]user[/red]", { messageType: "user", isStreaming: false, availableWidth: 80 })).toBe("[red]user[/red]");
    expect(transform("[red]thought[/red]", { messageType: "assistant-thinking", isStreaming: false, availableWidth: 80 })).toBe("[red]thought[/red]");

    const tuiCtx = createMockCtx();
    tuiCtx.mode = "tui";
    const [tuiResult] = await emitEvent(pi, "before_agent_start", { systemPrompt: "base" }, tuiCtx);
    expect(tuiResult).toEqual({ systemPrompt: appendColorOutputHint("base") });
    for (const color of ["red", "yellow", "green", "cyan", "magenta"]) {
      expect(tuiResult.systemPrompt).toContain(`<${color}>...</${color}>`);
      expect(COLOR_OUTPUT_HINT).not.toContain(`[${color}]`);
    }
    expect(COLOR_OUTPUT_HINT).not.toContain("ANSI");
    expect(COLOR_OUTPUT_HINT).not.toContain("errors");
    expect(COLOR_OUTPUT_HINT).not.toContain("sparingly");

    const printCtx = createMockCtx();
    printCtx.mode = "print";
    expect(await emitEvent(pi, "before_agent_start", { systemPrompt: "base" }, printCtx)).toEqual([undefined]);
  });
});
