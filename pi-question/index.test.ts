import { beforeEach, describe, expect, it } from "vitest";
import extension from "./index.ts";
import toolUi from "../pi-tool-ui/index.ts";
import { formatAnsweredOutput } from "./src/format.ts";
import { createQuestionState, questionSaveCustom, questionSelect, questionSetTab, questionStoreCustom, questionSubmit } from "./src/state.ts";
import { validateQuestions, type QuestionInfo } from "./src/schema.ts";
import { __test as uiTest } from "./src/ui.ts";
import { resetPipToolsForTests, flushPipTools } from "../pip-common/index.ts";
import { createMockPi, getRegisteredTool } from "../pip-common/testing.ts";

const questions: QuestionInfo[] = [
  {
    question: "Use generated fixture?",
    header: "Fixture",
    options: [
      { label: "Yes", description: "Generate it" },
      { label: "No", description: "Skip it" },
    ],
    custom: true,
  },
  {
    question: "Which checks?",
    header: "Checks",
    options: [
      { label: "Unit", description: "Unit tests" },
      { label: "E2E", description: "End-to-end tests" },
    ],
    multiple: true,
    custom: true,
  },
];

beforeEach(() => resetPipToolsForTests());

function exec(tool: any, params: any, customCtx: any = {}) {
  const ctx = {
    hasUI: true,
    ui: {
      custom: async () => ({ answers: [["Yes"]], rejected: false }),
    },
    ...customCtx,
  };
  return tool.execute("call-test", params, new AbortController().signal, undefined, ctx);
}

function makeComponent(qs: QuestionInfo[] = questions) {
  let result: any;
  const tui = { renders: 0, requestRender() { this.renders++; } };
  const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text };
  const component = new uiTest.QuestionComponent(tui, theme, (value: any) => { result = value; }, qs);
  return { component, tui, get result() { return result; } };
}

describe("pi-question", () => {
  it("registers the question tool", () => {
    const pi = createMockPi();
    extension(pi as any);
    flushPipTools(pi as any);
    expect(getRegisteredTool(pi, "question")).toBeTruthy();
  });

  it("returns answered output", async () => {
    const pi = createMockPi();
    extension(pi as any);
    flushPipTools(pi as any);
    const result = await exec(getRegisteredTool(pi, "question"), { questions: [questions[0]] });
    expect(result.content[0].text).toContain("User has answered your questions");
    expect(result.details.answers).toEqual([["Yes"]]);
    expect(result.details.rejected).toBe(false);
  });

  it("returns dismissed output", async () => {
    const pi = createMockPi();
    extension(pi as any);
    flushPipTools(pi as any);
    const result = await exec(getRegisteredTool(pi, "question"), { questions: [questions[0]] }, { ui: { custom: async () => ({ answers: [], rejected: true }) } });
    expect(result.content[0].text).toContain("dismissed");
    expect(result.details.rejected).toBe(true);
  });

  it("throws without UI", async () => {
    const pi = createMockPi();
    extension(pi as any);
    flushPipTools(pi as any);
    await expect(exec(getRegisteredTool(pi, "question"), { questions: [questions[0]] }, { hasUI: false, ui: {} })).rejects.toThrow(/interactive UI/);
  });

  it("validates empty questions", async () => {
    const pi = createMockPi();
    extension(pi as any);
    flushPipTools(pi as any);
    await expect(exec(getRegisteredTool(pi, "question"), { questions: [] })).rejects.toThrow(/at least one question/);
  });

  it("treats undefined UI custom result as dismissed", async () => {
    const pi = createMockPi();
    extension(pi as any);
    flushPipTools(pi as any);
    const result = await exec(getRegisteredTool(pi, "question"), { questions: [questions[0]] }, { ui: { custom: async () => undefined } });
    expect(result.details.rejected).toBe(true);
  });

  it("validates duplicate and empty option labels", () => {
    expect(() => validateQuestions([{ ...questions[0], options: [{ label: "", description: "Nope" }] }])).toThrow(/requires a label/);
    expect(() => validateQuestions([{ ...questions[0], options: [{ label: "Same", description: "One" }, { label: "same", description: "Two" }] }])).toThrow(/duplicate/);
  });

  it("single select submits immediately", () => {
    const step = questionSelect(createQuestionState(), [questions[0]]);
    expect(step.answers).toEqual([["Yes"]]);
  });

  it("multi-question advances and submits from confirm", () => {
    let state = createQuestionState();
    state = questionSelect(state, questions).state;
    expect(state.tab).toBe(1);
    state = questionSelect(state, questions).state;
    state = questionSelect({ ...state, selected: 1 }, questions).state;
    state = questionSetTab(state, 2);
    expect(questionSubmit(questions, state)).toEqual([["Yes"], ["Unit", "E2E"]]);
  });

  it("saves custom answer", () => {
    let state = createQuestionState();
    state = { ...state, selected: questions[0].options.length };
    state = questionSelect(state, [questions[0]]).state;
    state = questionStoreCustom(state, "Custom path");
    const step = questionSaveCustom(state, [questions[0]]);
    expect(step.answers).toEqual([["Custom path"]]);
  });

  it("formats unanswered questions", () => {
    expect(formatAnsweredOutput(questions, [["Yes"]])).toContain('"Which checks?"="Unanswered"');
  });

  it("keyboard flow supports digits, tabs, multiple toggles, and confirm", () => {
    const test = makeComponent();
    test.component.handleInput("1");
    expect(test.component.render(80).join("\n")).toContain("Which checks?");
    test.component.handleInput("2");
    test.component.handleInput("1");
    test.component.handleInput("\t");
    expect(test.component.render(80).join("\n")).toContain("Review");
    test.component.handleInput("\r");
    expect(test.result).toEqual({ answers: [["Yes"], ["E2E", "Unit"]], rejected: false });
  });

  it("keyboard flow supports arrows/jk/hl and dismiss", () => {
    const test = makeComponent();
    test.component.handleInput("\u001b[B");
    test.component.handleInput("\r");
    expect(test.component.render(80).join("\n")).toContain("Which checks?");
    test.component.handleInput("h");
    expect(test.component.render(80).join("\n")).toContain("Use generated fixture?");
    test.component.handleInput("l");
    test.component.handleInput("j");
    test.component.handleInput(" ");
    test.component.handleInput("k");
    test.component.handleInput(" ");
    test.component.handleInput("\u001b");
    expect(test.result).toEqual({ answers: [], rejected: true });
  });

  it("keyboard flow supports custom typing and edit escape discard", () => {
    const test = makeComponent([questions[0]]);
    test.component.handleInput("3");
    test.component.handleInput("x");
    expect(test.component.render(80).join("\n")).toContain("✎");
    test.component.handleInput("\u001b");
    const afterCancel = test.component.render(80).join("\n");
    expect(afterCancel).not.toContain("✎");
    expect(afterCancel).not.toContain("    x");
    test.component.handleInput("3");
    for (const ch of "Custom") test.component.handleInput(ch);
    test.component.handleInput("\r");
    expect(test.result).toEqual({ answers: [["Custom"]], rejected: false });
  });

  it("keyboard flow treats ctrl+c as dismissed", () => {
    const test = makeComponent([questions[0]]);
    test.component.handleInput("\u0003");
    expect(test.result).toEqual({ answers: [], rejected: true });
  });

  it("renders answered result", () => {
    const pi = createMockPi();
    extension(pi as any);
    flushPipTools(pi as any);
    const tool = getRegisteredTool(pi, "question");
    expect(tool).toBeTruthy();
    const result = tool.renderResult({ details: { questions: [questions[0]], answers: [["Yes"]], rejected: false }, content: [] }, {}, {});
    expect(result.render(80).join("\n")).toContain("Yes");
  });

  it("keeps answered result visible when tool-ui is loaded", () => {
    const pi = createMockPi();
    toolUi(pi as any);
    extension(pi as any);
    flushPipTools(pi as any);
    const tool = getRegisteredTool(pi, "question");
    expect(tool.renderShell).toBeUndefined();
    const rendered = tool.renderResult({ details: { questions: [questions[0]], answers: [["Yes"]], rejected: false }, content: [] }, { expanded: false }, {}).render(80).join("\n");
    expect(rendered).toContain("Yes");
    expect(rendered).not.toContain("⚠");
  });
});
