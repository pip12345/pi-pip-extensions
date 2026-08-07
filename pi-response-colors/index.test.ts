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

  it("leaves unknown, mismatched, and unclosed tags literal", () => {
    for (const source of [
      "[blue]unknown[/blue]",
      "[red]unclosed",
      "orphan[/red]",
      "[red]mismatch[/yellow]",
    ]) {
      expect(renderColorTags(source)).toBe(source);
    }
  });

  it("keeps generated color styling intact through Pi's Markdown renderer", () => {
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
    const transformed = renderColorTags("[red]**Bold red emphasis.**[/red]");
    const [line] = new Markdown(transformed, 0, 0, theme).render(80);

    expect(transformed).toBe(`**${RED}Bold red emphasis.${RESET}**`);
    expect(line).toContain(`\x1b[1m${RED}Bold red emphasis.${RESET}\x1b[22m`);
    expect(line).not.toContain("[red]");
  });
});

describe("pi-response-colors extension", () => {
  it("registers an assistant-only Markdown transformer and adds its hint only in interactive mode", async () => {
    const pi = createMockPi();
    responseColors(pi as any);

    expect(pi.markdownTransformers).toHaveLength(1);
    const transform = pi.markdownTransformers[0];
    expect(transform("[red]stop[/red]", { messageType: "assistant", isStreaming: false, availableWidth: 80 })).toBe(`${RED}stop${RESET}`);
    expect(transform("[red]user[/red]", { messageType: "user", isStreaming: false, availableWidth: 80 })).toBe("[red]user[/red]");
    expect(transform("[red]thought[/red]", { messageType: "assistant-thinking", isStreaming: false, availableWidth: 80 })).toBe("[red]thought[/red]");

    const tuiCtx = createMockCtx();
    tuiCtx.mode = "tui";
    const [tuiResult] = await emitEvent(pi, "before_agent_start", { systemPrompt: "base" }, tuiCtx);
    expect(tuiResult).toEqual({ systemPrompt: appendColorOutputHint("base") });
    expect(tuiResult.systemPrompt).toContain("[red]...[/red]");
    expect(COLOR_OUTPUT_HINT).not.toContain("ANSI");
    expect(COLOR_OUTPUT_HINT).not.toContain("errors");
    expect(COLOR_OUTPUT_HINT).not.toContain("sparingly");

    const printCtx = createMockCtx();
    printCtx.mode = "print";
    expect(await emitEvent(pi, "before_agent_start", { systemPrompt: "base" }, printCtx)).toEqual([undefined]);
  });
});
