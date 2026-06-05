import type { QuestionAnswer, QuestionInfo } from "./schema.ts";

export interface QuestionState {
  tab: number;
  selected: number;
  answers: QuestionAnswer[];
  custom: string[];
  editing: boolean;
}

export interface QuestionStep {
  state: QuestionState;
  answers?: QuestionAnswer[];
}

export function createQuestionState(): QuestionState {
  return { tab: 0, selected: 0, answers: [], custom: [], editing: false };
}

export function questionSingle(questions: readonly QuestionInfo[]): boolean {
  return questions.length === 1 && questions[0]?.multiple !== true;
}

export function questionTabs(questions: readonly QuestionInfo[]): number {
  return questionSingle(questions) ? 1 : questions.length + 1;
}

export function questionConfirm(questions: readonly QuestionInfo[], state: QuestionState): boolean {
  return !questionSingle(questions) && state.tab === questions.length;
}

export function questionInfo(questions: readonly QuestionInfo[], state: QuestionState): QuestionInfo | undefined {
  return questions[state.tab];
}

export function questionInput(state: QuestionState): string {
  return state.custom[state.tab] ?? "";
}

export function questionOther(questions: readonly QuestionInfo[], state: QuestionState): boolean {
  const info = questionInfo(questions, state);
  return Boolean(info && state.selected === info.options.length);
}

export function questionTotal(questions: readonly QuestionInfo[], state: QuestionState): number {
  const info = questionInfo(questions, state);
  if (!info) return 0;
  return info.options.length + 1;
}

export function questionAnswers(state: QuestionState, count: number): QuestionAnswer[] {
  return Array.from({ length: count }, (_, index) => state.answers[index] ?? []);
}

export function questionSetTab(state: QuestionState, tab: number): QuestionState {
  return { ...state, tab, selected: 0, editing: false };
}

export function questionMove(state: QuestionState, questions: readonly QuestionInfo[], dir: -1 | 1): QuestionState {
  const total = questionTotal(questions, state);
  if (!total) return state;
  return { ...state, selected: (state.selected + dir + total) % total };
}

export function questionStoreCustom(state: QuestionState, text: string): QuestionState {
  const custom = [...state.custom];
  custom[state.tab] = text;
  return { ...state, custom };
}

function storeAnswers(state: QuestionState, tab: number, list: string[]): QuestionState {
  const answers = [...state.answers];
  answers[tab] = list;
  return { ...state, answers };
}

function questionToggle(state: QuestionState, answer: string): QuestionState {
  const list = [...(state.answers[state.tab] ?? [])];
  const idx = list.indexOf(answer);
  if (idx === -1) list.push(answer);
  else list.splice(idx, 1);
  return storeAnswers(state, state.tab, list);
}

function questionPick(state: QuestionState, questions: readonly QuestionInfo[], answer: string, custom = false): QuestionStep {
  let next = storeAnswers({ ...state, editing: false }, state.tab, [answer]);
  if (custom) next = questionStoreCustom(next, answer);
  if (questionSingle(questions)) return { state: next, answers: [[answer]] };
  return { state: questionSetTab(next, state.tab + 1) };
}

export function questionSelect(state: QuestionState, questions: readonly QuestionInfo[]): QuestionStep {
  const info = questionInfo(questions, state);
  if (!info) return { state };

  if (questionOther(questions, state)) {
    if (!info.multiple) return { state: { ...state, editing: true } };
    const value = questionInput(state).trim();
    if (value && (state.answers[state.tab] ?? []).includes(value)) return { state: questionToggle(state, value) };
    return { state: { ...state, editing: true } };
  }

  const option = info.options[state.selected];
  if (!option) return { state };
  if (info.multiple) return { state: questionToggle(state, option.label) };
  return questionPick(state, questions, option.label);
}

export function questionSaveCustom(state: QuestionState, questions: readonly QuestionInfo[]): QuestionStep {
  const info = questionInfo(questions, state);
  if (!info) return { state };

  const value = questionInput(state).trim();
  const previous = state.custom[state.tab];
  if (!value) {
    const withoutPrevious = previous ? (state.answers[state.tab] ?? []).filter((item) => item !== previous) : (state.answers[state.tab] ?? []);
    return { state: storeAnswers({ ...questionStoreCustom(state, ""), editing: false }, state.tab, withoutPrevious) };
  }

  if (info.multiple) {
    let answers = [...(state.answers[state.tab] ?? [])];
    if (previous) answers = answers.filter((item) => item !== previous);
    if (!answers.includes(value)) answers.push(value);
    return { state: storeAnswers({ ...questionStoreCustom(state, value), editing: false }, state.tab, answers) };
  }

  return questionPick(state, questions, value, true);
}

export function questionSubmit(questions: readonly QuestionInfo[], state: QuestionState): QuestionAnswer[] {
  return questionAnswers(state, questions.length);
}
