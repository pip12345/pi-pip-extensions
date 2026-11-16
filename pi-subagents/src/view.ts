import { boxLines, PipCustomComponent, printableInput, themeFg, truncateToWidth, visibleWidth, wrapAnsi } from "../../pip-common/index.ts";
import { elapsed } from "./render.ts";
import { runMessages, type SubagentRun, type SubagentRuns } from "./runs.ts";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
}

function argsSummary(args: any): string {
  if (!args || typeof args !== "object") return "";
  const keys = ["path", "pattern", "query", "command", "url", "code"].filter((key) => args[key] != null);
  return (keys.length ? keys.slice(0, 2).map((key) => args[key]) : [JSON.stringify(args)]).map((value) => String(value).replace(/\s+/g, " ")).join(" ");
}

/** Steering notes reach the child wrapped in instructions; the viewer shows only the note. */
function steeringText(text: string): string | undefined {
  return /^<subagent_steering>\n[^\n]*\n\n([\s\S]*)\n<\/subagent_steering>$/.exec(text)?.[1];
}

/** Live, read-mostly view of one run's transcript, with steering and cancel. */
export class SubagentViewer extends PipCustomComponent<void> {
  private readonly timer: ReturnType<typeof setInterval>;
  private scrollFromBottom = 0;
  private lastBodyLength = 0;
  private steerText: string | undefined;
  private notice = "";

  constructor(tui: any, theme: any, done: () => void, private readonly runs: SubagentRuns, private readonly run: SubagentRun) {
    super(tui, theme, done, { closeKeys: ["escape", "ctrl+c", "q"] });
    this.timer = setInterval(() => this.requestRender(), 500);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  handleInput(data: string): void {
    if (this.steerText === undefined) return super.handleInput(data);
    const key = printableInput(data);
    if (data === "\u001b") this.steerText = undefined;
    else if (data === "\r" || data === "\n") this.submitSteer();
    else if (data === "\u007f" || data === "\b") this.steerText = Array.from(this.steerText).slice(0, -1).join("");
    else if (typeof key === "string") this.steerText += key;
    this.requestRender();
  }

  protected handleKey(key: string): void {
    if (key === "s") this.steerText = "";
    else if (key === "c") void this.cancel();
    else if (key === "up" || key === "k") this.scrollFromBottom += 1;
    else if (key === "down" || key === "j") this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 1);
    else if (key === "pageup") this.scrollFromBottom += 10;
    else if (key === "pagedown") this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 10);
    else if (key === "home") this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
    else if (key === "end") this.scrollFromBottom = 0;
    this.requestRender();
  }

  private submitSteer(): void {
    const message = this.steerText?.trim();
    this.steerText = undefined;
    if (!message) return;
    this.scrollFromBottom = 0;
    // An idle run continues in the background so its reply reaches the parent as a follow-up.
    this.runs.message(this.run, message, { background: true })
      .then((outcome) => { this.notice = outcome === "steered" ? "Steering note sent" : "Continuing in background"; })
      .catch((error) => { this.notice = error instanceof Error ? error.message : String(error); })
      .finally(() => this.requestRender());
  }

  private async cancel(): Promise<void> {
    try {
      await this.runs.cancel(this.run);
      this.notice = "Cancelled";
    } catch (error) {
      this.notice = error instanceof Error ? error.message : String(error);
    }
    this.requestRender();
  }

  private label(name: string, color: string, text: string, width: number, lines: string[]): void {
    const prefix = themeFg(this.theme, color, `${name} › `);
    const indent = " ".repeat(visibleWidth(prefix));
    const wrapped = text.trimEnd().split("\n").flatMap((line) => wrapAnsi(line, Math.max(1, width - visibleWidth(prefix))));
    wrapped.forEach((line, index) => lines.push(`${index ? indent : prefix}${line}`));
  }

  private transcript(width: number): string[] {
    const lines: string[] = [];
    for (const message of runMessages(this.run)) {
      if (message?.role === "user") {
        const text = textOf(message.content);
        const steer = steeringText(text);
        this.label(steer === undefined ? "user" : "steer", steer === undefined ? "muted" : "warning", steer ?? text, width, lines);
      } else if (message?.role === "assistant") {
        for (const part of Array.isArray(message.content) ? message.content : []) {
          if (part?.type === "text" && part.text?.trim()) this.label("agent", "accent", part.text, width, lines);
          else if (part?.type === "toolCall") lines.push(truncateToWidth(`${themeFg(this.theme, "muted", "tool › ")}${part.name} ${argsSummary(part.arguments)}`, width));
        }
        if (message.stopReason === "error" && message.errorMessage) this.label("error", "error", message.errorMessage, width, lines);
      } else if (message?.role === "toolResult") {
        const mark = message.isError ? themeFg(this.theme, "error", "✗") : themeFg(this.theme, "success", "✓");
        const first = textOf(message.content).split("\n").find((line) => line.trim()) ?? "";
        lines.push(truncateToWidth(`${themeFg(this.theme, "muted", "     › ")}${mark} ${first.trim()}`, width));
      }
    }
    if (this.run.status !== "running" && this.run.errorText) this.label("error", "error", this.run.errorText, width, lines);
    return lines;
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const run = this.run;
    const header = [
      themeFg(this.theme, "dim", "↑↓/PgUp/PgDn scroll · End follow · s steer · c cancel · q close"),
      `${themeFg(this.theme, "accent", run.id)} ${run.agent.name}${run.model ? themeFg(this.theme, "dim", ` · ${run.model}`) : ""}`,
      [run.status, elapsed(run), `${run.toolCalls} tools`, run.background ? "background" : "foreground"].join(themeFg(this.theme, "dim", " · ")),
    ];
    if (this.notice) header.push(themeFg(this.theme, "warning", this.notice));
    const footer = this.steerText === undefined ? [] : [`${themeFg(this.theme, "accent", "steer> ")}${this.steerText || themeFg(this.theme, "dim", "type a message, Enter sends, Esc cancels")}`];
    const rows = Math.max(1, this.overlayRowBudget({ maxRows: 200, minRows: 12 }) - 2);
    const bodyRows = Math.max(1, rows - header.length - footer.length);
    const body = this.transcript(inner);
    // Keep a scrolled-up view anchored while new output arrives below it.
    if (this.scrollFromBottom > 0) this.scrollFromBottom += Math.max(0, body.length - this.lastBodyLength);
    this.lastBodyLength = body.length;
    const scroll = Math.min(this.scrollFromBottom, Math.max(0, body.length - bodyRows));
    this.scrollFromBottom = scroll;
    const visible = body.slice(Math.max(0, body.length - bodyRows - scroll), body.length - scroll);
    const lines = [...header, ...visible, ...footer].map((line) => truncateToWidth(line, inner));
    while (lines.length < rows) lines.push("");
    return boxLines(lines, width, this.theme, { title: `Subagent ${run.id}` });
  }
}
