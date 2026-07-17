import { boxLines, hasTuiCustom, PipCustomComponent, printableInput, scrollForKey, scrollWindow, selectionWindow, themeFg, truncateToWidth, visibleWidth, wrapAnsi } from "../../pip-common/index.ts";
import type { QuestionAnswer, QuestionInfo } from "./schema.ts";
import {
  createQuestionState,
  questionConfirm,
  questionInfo,
  questionInput,
  questionMove,
  questionSaveCustom,
  questionSelect,
  questionSetTab,
  questionSingle,
  questionStoreCustom,
  questionSubmit,
  questionTabs,
  questionTotal,
  type QuestionState,
} from "./state.ts";

export type AskQuestionResult = { answers: QuestionAnswer[]; rejected: false } | { answers: []; rejected: true };

class QuestionComponent extends PipCustomComponent<AskQuestionResult> {
  private state: QuestionState = createQuestionState();
  private optionOffset = 0;
  private confirmOffset = 0;
  private confirmPageSize = 1;

  constructor(tui: any, theme: any, done: (result?: AskQuestionResult) => void, private readonly questions: QuestionInfo[]) {
    super(tui, theme, done, { closeKeys: [] });
  }

  protected handleKey(key: string, raw: string): void {
    if (this.state.editing) {
      if (key === "escape") {
        this.setState(questionStoreCustom({ ...this.state, editing: false }, ""));
        this.requestRender();
        return;
      }
      if (key === "return") {
        const next = questionSaveCustom(this.state, this.questions);
        this.setState(next.state);
        if (next.answers) this.close({ answers: next.answers, rejected: false });
        else this.requestRender();
        return;
      }
      if (key === "backspace") {
        this.setState(questionStoreCustom(this.state, questionInput(this.state).slice(0, -1)));
        this.requestRender();
        return;
      }
      const printable = printableInput(raw);
      if (printable) {
        this.setState(questionStoreCustom(this.state, questionInput(this.state) + printable));
        this.requestRender();
      }
      return;
    }

    if (key === "escape" || key === "ctrl+c" || key === "ctrl+d") {
      this.close({ answers: [], rejected: true });
      return;
    }

    const tabs = questionTabs(this.questions);
    if (!questionSingle(this.questions) && (key === "tab" || key === "right" || key === "l")) {
      this.setState(questionSetTab(this.state, (this.state.tab + 1) % tabs));
      this.requestRender();
      return;
    }
    if (!questionSingle(this.questions) && (key === "shift+tab" || key === "left" || key === "h")) {
      this.setState(questionSetTab(this.state, (this.state.tab - 1 + tabs) % tabs));
      this.requestRender();
      return;
    }

    if (questionConfirm(this.questions, this.state)) {
      if (key === "return") {
        this.close({ answers: questionSubmit(this.questions, this.state), rejected: false });
        return;
      }
      const offset = scrollForKey(key, this.confirmOffset, this.questions.length, this.confirmPageSize);
      if (offset !== undefined) {
        this.confirmOffset = offset;
        this.requestRender();
      }
      return;
    }

    const total = questionTotal(this.questions, this.state);
    const digit = Number(key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(total, 9)) {
      this.choose(digit - 1);
      return;
    }
    if (key === "up" || key === "k") {
      this.setState(questionMove(this.state, this.questions, -1));
      this.requestRender();
      return;
    }
    if (key === "down" || key === "j") {
      this.setState(questionMove(this.state, this.questions, 1));
      this.requestRender();
      return;
    }
    if (key === "return" || key === "space") this.choose(this.state.selected);
  }

  private choose(selected: number): void {
    this.setState({ ...this.state, selected });
    const next = questionSelect(this.state, this.questions);
    this.setState(next.state);
    if (next.answers) this.close({ answers: next.answers, rejected: false });
    else this.requestRender();
  }

  private setState(next: QuestionState): void {
    if (next.tab !== this.state.tab) {
      this.optionOffset = 0;
      this.confirmOffset = 0;
    }
    this.state = next;
  }

  render(width: number): string[] {
    const bodyWidth = Math.max(1, width);
    const innerWidth = Math.max(1, bodyWidth - 4);
    const lines: string[] = [];
    const bodyRows = this.overlayRowBudget({ maxRows: 24, minRows: 6, reservedRows: 2, maxHeightRatio: 0.8 });

    if (!questionSingle(this.questions)) this.renderTabs(lines, innerWidth);
    const hintLines = wrapAnsi(themeFg(this.theme, "dim", this.hint()), innerWidth);
    const tail = ["", ...hintLines];
    const contentRows = Math.max(1, bodyRows - lines.length - tail.length);
    if (questionConfirm(this.questions, this.state)) this.renderConfirm(lines, innerWidth, contentRows);
    else this.renderQuestion(lines, innerWidth, contentRows);
    lines.push(...tail);
    return boxLines(lines, bodyWidth, this.theme, { title: "Question" });
  }

  private renderTabs(lines: string[], width: number): void {
    const parts = this.questions.map((q, index) => {
      const active = this.state.tab === index;
      const answered = (this.state.answers[index]?.length ?? 0) > 0;
      const label = `${answered ? "■" : "□"} ${q.header}`;
      return active ? themeFg(this.theme, "accent", `[${label}]`) : themeFg(this.theme, answered ? "success" : "muted", label);
    });
    parts.push(this.state.tab === this.questions.length ? themeFg(this.theme, "accent", "[Confirm]") : themeFg(this.theme, "muted", "Confirm"));
    const full = parts.join("  ");
    if (visibleWidth(full) <= width) lines.push(full);
    else {
      const before = this.state.tab;
      const after = parts.length - this.state.tab - 1;
      const active = parts[this.state.tab] ?? "";
      lines.push(truncateToWidth(`${before ? `← ${before}  ` : ""}${active}${after ? `  ${after} →` : ""}`, width));
    }
    lines.push("");
  }

  private renderQuestion(lines: string[], width: number, rowBudget: number): void {
    const info = questionInfo(this.questions, this.state);
    if (!info) return;
    const question = themeFg(this.theme, "text", info.question + (info.multiple ? " (select all that apply)" : ""));
    const wrappedQuestion = wrapAnsi(question, width);
    const questionRows = Math.min(wrappedQuestion.length, Math.max(1, Math.floor(rowBudget / 3)));
    lines.push(...wrappedQuestion.slice(0, questionRows));
    if (wrappedQuestion.length > questionRows) lines[lines.length - 1] = truncateToWidth(`${lines.at(-1) ?? ""} …`, width);

    let optionRows = Math.max(1, rowBudget - questionRows);
    if (optionRows > 1) {
      lines.push("");
      optionRows--;
    }
    const blocks = [
      ...info.options.map((option, index) => this.renderOption(width, index, option.label, option.description, false)),
      this.renderOption(width, info.options.length, "Type your own answer", questionInput(this.state), true),
    ];
    const flat = blocks.flat();
    const selectedRow = blocks.slice(0, this.state.selected).reduce((total, block) => total + block.length, 0);
    const showPosition = flat.length > optionRows && optionRows > 1;
    const pageSize = Math.max(1, optionRows - (showPosition ? 1 : 0));
    const selectedView = selectionWindow(flat, selectedRow, this.optionOffset, pageSize);
    const alignedOffset = this.alignOptionOffset(blocks, selectedView.offset, selectedRow, pageSize);
    const view = scrollWindow(flat, alignedOffset, pageSize);
    this.optionOffset = view.offset;
    lines.push(...view.items);
    if (showPosition) {
      const below = flat.length - view.end;
      lines.push(themeFg(this.theme, "dim", `${this.state.selected + 1}/${blocks.length} · ${view.offset} rows above · ${below} below`));
    }
  }

  private alignOptionOffset(blocks: string[][], offset: number, selectedRow: number, pageSize: number): number {
    let blockStart = 0;
    for (const block of blocks) {
      const blockEnd = blockStart + block.length;
      if (offset > blockStart && offset < blockEnd) {
        return selectedRow >= blockEnd && selectedRow < blockEnd + pageSize ? blockEnd : blockStart;
      }
      blockStart = blockEnd;
    }
    return offset;
  }

  private renderOption(width: number, index: number, label: string, description = "", custom: boolean): string[] {
    const info = questionInfo(this.questions, this.state);
    const selected = this.state.selected === index;
    const picked = custom ? Boolean(questionInput(this.state) && this.state.answers[this.state.tab]?.includes(questionInput(this.state))) : Boolean(this.state.answers[this.state.tab]?.includes(label));
    const prefix = selected ? themeFg(this.theme, "accent", "›") : " ";
    const check = info?.multiple ? `[${picked ? "✓" : " "}] ` : picked ? "✓ " : "";
    const text = `${prefix} ${index + 1}. ${check}${label}${custom && this.state.editing ? " ✎" : ""}`;
    const lines = [truncateToWidth(selected ? themeFg(this.theme, "accent", text) : themeFg(this.theme, picked ? "success" : "text", text), width)];
    if (description) {
      for (const line of wrapAnsi(themeFg(this.theme, "muted", description), Math.max(1, width - 4))) lines.push(`    ${line}`);
    }
    return lines;
  }

  private renderConfirm(lines: string[], width: number, rowBudget: number): void {
    lines.push(themeFg(this.theme, "text", "Review"));
    if (rowBudget <= 1) return;
    lines.push("");
    const answers = this.questions.map((q, index) => {
      const answer = this.state.answers[index]?.join(", ") || "(not answered)";
      const color = this.state.answers[index]?.length ? "text" : "warning";
      return truncateToWidth(`${themeFg(this.theme, "muted", `${q.header}:`)} ${themeFg(this.theme, color, answer)}`, width);
    });
    const available = Math.max(1, rowBudget - 2);
    const showPosition = answers.length > available && available > 1;
    this.confirmPageSize = Math.max(1, available - (showPosition ? 1 : 0));
    const view = scrollWindow(answers, this.confirmOffset, this.confirmPageSize);
    this.confirmOffset = view.offset;
    lines.push(...view.items);
    if (showPosition) lines.push(themeFg(this.theme, "dim", `${view.offset + 1}–${view.end} of ${answers.length}`));
  }

  private hint(): string {
    if (this.state.editing) return "type answer · enter save · esc cancel";
    if (questionConfirm(this.questions, this.state)) return "j/k scroll · enter submit · esc dismiss";
    const info = questionInfo(this.questions, this.state);
    const verb = info?.multiple ? "toggle" : questionSingle(this.questions) ? "submit" : "confirm";
    return `${questionSingle(this.questions) ? "" : "tab/←→ questions · "}↑↓ select · 1-9 pick · enter ${verb} · esc dismiss`;
  }
}

export async function askQuestions(ctx: any, questions: QuestionInfo[]): Promise<AskQuestionResult> {
  if (!hasTuiCustom(ctx)) throw new Error("question requires interactive UI.");
  const result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (result?: AskQuestionResult) => void) => new QuestionComponent(tui, theme, done, questions));
  return result ?? { answers: [], rejected: true };
}

export const __test = { QuestionComponent };
