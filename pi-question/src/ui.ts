import { boxLines, PipCustomComponent, printableInput, themeFg, truncateToWidth } from "../../pip-common/index.ts";
import type { QuestionAnswer, QuestionInfo } from "./schema.ts";
import {
  createQuestionState,
  questionConfirm,
  questionCustom,
  questionInfo,
  questionInput,
  questionMove,
  questionOther,
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

  constructor(tui: any, theme: any, done: (result?: AskQuestionResult) => void, private readonly questions: QuestionInfo[]) {
    super(tui, theme, done, { closeKeys: [] });
  }

  protected handleKey(key: string, raw: string): void {
    if (this.state.editing) {
      if (key === "escape") {
        this.state = questionStoreCustom({ ...this.state, editing: false }, "");
        this.requestRender();
        return;
      }
      if (key === "return") {
        const next = questionSaveCustom(this.state, this.questions);
        this.state = next.state;
        if (next.answers) this.close({ answers: next.answers, rejected: false });
        else this.requestRender();
        return;
      }
      if (key === "backspace") {
        this.state = questionStoreCustom(this.state, questionInput(this.state).slice(0, -1));
        this.requestRender();
        return;
      }
      const printable = printableInput(raw);
      if (printable) {
        this.state = questionStoreCustom(this.state, questionInput(this.state) + printable);
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
      this.state = questionSetTab(this.state, (this.state.tab + 1) % tabs);
      this.requestRender();
      return;
    }
    if (!questionSingle(this.questions) && (key === "shift+tab" || key === "left" || key === "h")) {
      this.state = questionSetTab(this.state, (this.state.tab - 1 + tabs) % tabs);
      this.requestRender();
      return;
    }

    if (questionConfirm(this.questions, this.state)) {
      if (key === "return") this.close({ answers: questionSubmit(this.questions, this.state), rejected: false });
      return;
    }

    const total = questionTotal(this.questions, this.state);
    const digit = Number(key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(total, 9)) {
      this.choose(digit - 1);
      return;
    }
    if (key === "up" || key === "k") {
      this.state = questionMove(this.state, this.questions, -1);
      this.requestRender();
      return;
    }
    if (key === "down" || key === "j") {
      this.state = questionMove(this.state, this.questions, 1);
      this.requestRender();
      return;
    }
    if (key === "return" || key === "space") this.choose(this.state.selected);
  }

  private choose(selected: number): void {
    this.state = { ...this.state, selected };
    const next = questionSelect(this.state, this.questions);
    this.state = next.state;
    if (next.answers) this.close({ answers: next.answers, rejected: false });
    else this.requestRender();
  }

  render(width: number): string[] {
    const bodyWidth = Math.max(50, Math.min(width, 100));
    const innerWidth = bodyWidth - 4;
    const th = this.theme;
    const lines: string[] = [];

    if (!questionSingle(this.questions)) this.renderTabs(lines, innerWidth);
    if (questionConfirm(this.questions, this.state)) this.renderConfirm(lines, innerWidth);
    else this.renderQuestion(lines, innerWidth);

    lines.push("");
    lines.push(themeFg(th, "dim", this.hint()));
    return boxLines(lines, bodyWidth, th, { title: "Question" });
  }

  private renderTabs(lines: string[], width: number): void {
    const parts = this.questions.map((q, index) => {
      const active = this.state.tab === index;
      const answered = (this.state.answers[index]?.length ?? 0) > 0;
      const label = `${answered ? "■" : "□"} ${q.header}`;
      return active ? themeFg(this.theme, "accent", `[${label}]`) : themeFg(this.theme, answered ? "success" : "muted", label);
    });
    const confirm = this.state.tab === this.questions.length ? themeFg(this.theme, "accent", "[Confirm]") : themeFg(this.theme, "muted", "Confirm");
    lines.push(truncateToWidth([...parts, confirm].join("  "), width));
    lines.push("");
  }

  private renderQuestion(lines: string[], width: number): void {
    const info = questionInfo(this.questions, this.state);
    if (!info) return;
    lines.push(themeFg(this.theme, "text", info.question + (info.multiple ? " (select all that apply)" : "")));
    lines.push("");
    for (const [index, option] of info.options.entries()) this.renderOption(lines, width, index, option.label, option.description, false);
    if (questionCustom(this.questions, this.state)) this.renderOption(lines, width, info.options.length, "Type your own answer", questionInput(this.state), true);
  }

  private renderOption(lines: string[], width: number, index: number, label: string, description = "", custom: boolean): void {
    const info = questionInfo(this.questions, this.state);
    const selected = this.state.selected === index;
    const picked = custom ? Boolean(questionInput(this.state) && this.state.answers[this.state.tab]?.includes(questionInput(this.state))) : Boolean(this.state.answers[this.state.tab]?.includes(label));
    const prefix = selected ? themeFg(this.theme, "accent", "›") : " ";
    const check = info?.multiple ? `[${picked ? "✓" : " "}] ` : picked ? "✓ " : "";
    const text = `${prefix} ${index + 1}. ${check}${label}${custom && this.state.editing ? " ✎" : ""}`;
    lines.push(truncateToWidth(selected ? themeFg(this.theme, "accent", text) : themeFg(this.theme, picked ? "success" : "text", text), width));
    if (description) lines.push(truncateToWidth(`    ${themeFg(this.theme, "muted", description)}`, width));
  }

  private renderConfirm(lines: string[], width: number): void {
    lines.push(themeFg(this.theme, "text", "Review"));
    lines.push("");
    for (const [index, q] of this.questions.entries()) {
      const answer = this.state.answers[index]?.join(", ") || "(not answered)";
      const color = this.state.answers[index]?.length ? "text" : "warning";
      lines.push(truncateToWidth(`${themeFg(this.theme, "muted", `${q.header}:`)} ${themeFg(this.theme, color, answer)}`, width));
    }
  }

  private hint(): string {
    if (this.state.editing) return "type answer · enter save · esc cancel";
    if (questionConfirm(this.questions, this.state)) return "enter submit · esc dismiss";
    const info = questionInfo(this.questions, this.state);
    const verb = info?.multiple ? "toggle" : questionSingle(this.questions) ? "submit" : "confirm";
    return `${questionSingle(this.questions) ? "" : "tab/←→ questions · "}↑↓ select · 1-9 pick · enter ${verb} · esc dismiss`;
  }
}

export async function askQuestions(ctx: any, questions: QuestionInfo[]): Promise<AskQuestionResult> {
  if (!ctx?.hasUI || !ctx?.ui?.custom) throw new Error("question requires interactive UI.");
  const result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (result?: AskQuestionResult) => void) => new QuestionComponent(tui, theme, done, questions));
  return result ?? { answers: [], rejected: true };
}

export const __test = { QuestionComponent };
