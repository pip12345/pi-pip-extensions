import { boxLines, normalizeInputKey, PipCustomComponent, printableInput, themeFg, truncateToWidth, visibleWidth, wrapAnsi } from "pip-common";
import type { SubagentManager } from "./manager.ts";
import type { SubagentEvent, SubagentRun, SubagentSnapshot } from "./types.ts";

function elapsed(run: SubagentSnapshot): string {
  const end = run.completedAt ?? Date.now();
  return `${((end - run.createdAt) / 1000).toFixed(1)}s`;
}

function appendWrapped(lines: string[], label: string, text: string, width: number): void {
  const wrapped = text.split("\n").flatMap((line) => wrapAnsi(line, width));
  const continuation = " ".repeat(visibleWidth(label));
  wrapped.forEach((line, index) => lines.push(`${index === 0 ? label : continuation}${line}`));
}

function terminalRows(): number {
  return Math.max(12, process.stdout?.rows ?? 40);
}

function safeWidth(width: number): number {
  return Math.max(1, width);
}

export class SubagentViewer extends PipCustomComponent<void> {
  private message = "";
  private timer: NodeJS.Timeout | undefined;
  private scrollFromBottom = 0;
  private steerMode = false;
  private steerText = "";
  private steering = false;
  private lastContentLength: number | undefined;

  constructor(
    tui: any,
    theme: any,
    done: () => void,
    private readonly ctx: any,
    private readonly manager: SubagentManager,
    private readonly runId: string,
  ) {
    super(tui, theme, done, { closeKeys: ["escape", "ctrl+c", "ctrl+d", "q", "Q"] });
    this.timer = setInterval(() => this.requestRender(), 1000);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private run(): SubagentRun | undefined {
    return this.manager.resolve(this.runId);
  }

  handleInput(data: string): void {
    if (!this.steerMode) return super.handleInput(data);

    const normalized = normalizeInputKey(data);
    const key = printableInput(data);
    if (normalized === "ctrl+c" || normalized === "ctrl+d") {
      this.close();
      return;
    }
    if (normalized === "escape") {
      this.steerMode = false;
      this.steerText = "";
      this.message = "Steer cancelled";
      this.requestRender();
      return;
    }
    if (normalized === "return") {
      const run = this.run();
      const message = this.steerText.trim();
      this.steerMode = false;
      this.steerText = "";
      if (run && message) void this.submitSteer(run, message);
      else this.requestRender();
      return;
    }
    if (normalized === "backspace" || data === "\u007f" || data === "\b") {
      this.steerText = Array.from(this.steerText).slice(0, -1).join("");
      this.requestRender();
      return;
    }
    if (typeof key === "string") {
      this.steerText += key;
      this.requestRender();
    }
  }

  protected handleKey(key: string): void {
    const run = this.run();
    if (!run) {
      this.close();
      return;
    }
    if (key === "s") this.startSteer();
    else if (key === "c") void this.cancel(run);
    else if (key === "b") this.background(run);
    else if (key === "k") this.keep(run);
    else if (key === "f") this.forget(run);
    else if (key === "r") this.requestRender();
    else if (key === "up") this.scroll(1);
    else if (key === "down" || key === "j") this.scroll(-1);
    else if (key === "pageup") this.scroll(10);
    else if (key === "pagedown") this.scroll(-10);
    else if (key === "home") this.scrollToTop();
    else if (key === "end") this.scrollToBottom();
  }

  private startSteer(): void {
    this.steerMode = true;
    this.steerText = "";
    this.message = "";
    this.requestRender();
  }

  private scroll(delta: number): void {
    this.scrollFromBottom = Math.max(0, this.scrollFromBottom + delta);
    this.requestRender();
  }

  private scrollToTop(): void {
    this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
    this.requestRender();
  }

  private scrollToBottom(): void {
    this.scrollFromBottom = 0;
    this.requestRender();
  }

  private async submitSteer(run: SubagentRun, message: string): Promise<void> {
    if (this.steering) return;
    this.steering = true;
    try {
      await this.manager.steer(run, message);
      this.message = `Steered ${run.id}`;
      this.scrollToBottom();
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      this.steering = false;
      this.requestRender();
    }
  }

  private async cancel(run: SubagentRun): Promise<void> {
    try {
      await this.manager.cancel(run);
      this.message = `Cancelled ${run.id}`;
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    }
    this.requestRender();
  }

  private background(run: SubagentRun): void {
    try {
      this.manager.detach(run);
      this.message = `Moved ${run.id} to background`;
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    }
    this.requestRender();
  }

  private keep(run: SubagentRun): void {
    this.manager.keep(run);
    this.message = `Kept ${run.id}`;
    this.requestRender();
  }

  private forget(run: SubagentRun): void {
    try {
      this.manager.forget(run);
      this.close();
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
      this.requestRender();
    }
  }

  private contentLines(snapshot: SubagentSnapshot, inner: number): string[] {
    const contentWidth = Math.max(1, inner - 10);
    const lines: string[] = [];
    appendWrapped(lines, themeFg(this.theme, "muted", "user › "), snapshot.prompt, contentWidth);

    let assistantBuffer = "";
    const flushAssistant = () => {
      const text = assistantBuffer.trimEnd();
      assistantBuffer = "";
      if (text) appendWrapped(lines, themeFg(this.theme, "accent", "agent › "), text, contentWidth);
    };

    for (const event of snapshot.events) {
      if (event.type === "text_delta") {
        assistantBuffer += event.text;
        continue;
      }
      flushAssistant();
      if (event.type === "steer") {
        appendWrapped(lines, themeFg(this.theme, "warning", "steer › "), event.text, contentWidth);
      } else if (event.type === "tool_start") {
        const args = event.argsSummary ? ` ${event.argsSummary}` : "";
        lines.push(truncateToWidth(themeFg(this.theme, "muted", "tool › ") + `${event.name}${args}`, inner));
      } else if (event.type === "tool_end") {
        const status = event.ok ? themeFg(this.theme, "success", "✓") : themeFg(this.theme, "error", "✗");
        const duration = event.durationMs != null ? ` ${event.durationMs}ms` : "";
        const preview = event.resultSummary ? ` · ${event.resultSummary}` : "";
        lines.push(truncateToWidth(themeFg(this.theme, "muted", "tool › ") + `${status}${duration}${preview}`, inner));
      }
    }
    flushAssistant();

    if (snapshot.errorText) appendWrapped(lines, themeFg(this.theme, "error", "error › "), snapshot.errorText, contentWidth);
    return lines;
  }

  render(width: number): string[] {
    const run = this.run();
    const bodyWidth = safeWidth(width);
    const inner = Math.max(1, bodyWidth - 4);
    if (!run) return boxLines([themeFg(this.theme, "error", `Subagent not found: ${this.runId}`)], bodyWidth, this.theme, { title: "Subagent" });

    const snapshot = this.manager.snapshot(run);
    const statusColor = snapshot.status === "error" ? "error" : snapshot.status === "completed" ? "success" : snapshot.status === "cancelled" ? "warning" : "accent";
    const chrome: string[] = [];
    chrome.push(themeFg(this.theme, "dim", "↑↓/PgUp/PgDn scroll · End follow · r refresh · s steer · c cancel · b background · k keep · f forget · q close"));
    chrome.push(`${themeFg(this.theme, "accent", snapshot.id)} ${snapshot.name ? `(${snapshot.name}) ` : ""}${snapshot.agent}`);
    chrome.push([themeFg(this.theme, statusColor, snapshot.status), elapsed(snapshot), snapshot.background ? "background" : "foreground", snapshot.keep ? "kept" : "ephemeral"].join(themeFg(this.theme, "dim", " · ")));
    if (this.message) chrome.push(themeFg(this.theme, this.message.toLowerCase().includes("error") ? "error" : "warning", this.message));

    const content = this.contentLines(snapshot, inner);
    if (this.scrollFromBottom > 0 && this.lastContentLength != null && content.length > this.lastContentLength) {
      this.scrollFromBottom += content.length - this.lastContentLength;
    }
    this.lastContentLength = content.length;
    const footer: string[] = [];
    if (this.steerMode) footer.push(themeFg(this.theme, "accent", `steer> `) + truncateToWidth(this.steerText || themeFg(this.theme, "dim", "type message, enter sends, esc cancels"), Math.max(1, inner - 7)));
    else if (this.steering) footer.push(themeFg(this.theme, "accent", "Sending steer…"));

    const targetInnerLines = Math.max(1, terminalRows() - 2);
    const reservedLines = chrome.length + 1 + footer.length;
    const maxBodyLines = Math.max(0, targetInnerLines - reservedLines);
    const maxScroll = Math.max(0, content.length - maxBodyLines);
    const scroll = Math.min(this.scrollFromBottom, maxScroll);
    if (this.scrollFromBottom !== scroll) this.scrollFromBottom = scroll;
    const start = Math.max(0, content.length - maxBodyLines - scroll);
    const visible = maxBodyLines > 0 ? content.slice(start, start + maxBodyLines) : [];
    const scrollInfo = content.length > maxBodyLines ? themeFg(this.theme, "dim", `lines ${start + 1}-${start + visible.length}/${content.length}${scroll === 0 ? " · live" : ` · +${scroll} from bottom`}`) : themeFg(this.theme, "dim", "all output visible");

    const lines = [...chrome, scrollInfo, ...visible, ...footer].map((line) => truncateToWidth(line, inner));
    while (lines.length < targetInnerLines) lines.push("");
    return boxLines(lines.slice(0, targetInnerLines), bodyWidth, this.theme, { title: `Subagent ${snapshot.id}` });
  }
}
