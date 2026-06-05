import { Type, type Static } from "typebox";

export const QuestionOptionSchema = Type.Object({
  label: Type.String({ minLength: 1, description: "Display text (1-5 words, concise)" }),
  description: Type.String({ minLength: 1, description: "Explanation of choice" }),
});

export const QuestionInfoSchema = Type.Object({
  question: Type.String({ minLength: 1, description: "Complete question" }),
  header: Type.String({ minLength: 1, maxLength: 30, description: "Very short label (max 30 chars)" }),
  options: Type.Optional(Type.Array(QuestionOptionSchema, { description: "Available choices" })),
  multiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple choices" })),
});

export const QuestionParams = Type.Object({
  questions: Type.Array(QuestionInfoSchema, { minItems: 1, description: "Questions to ask" }),
});

export type QuestionOption = Static<typeof QuestionOptionSchema>;
type QuestionInputInfo = Static<typeof QuestionInfoSchema>;
export type QuestionInfo = Omit<QuestionInputInfo, "options"> & { options: QuestionOption[] };
export type QuestionParamsType = Static<typeof QuestionParams>;
export type QuestionAnswer = string[];

export interface QuestionResultDetails {
  questions: QuestionInfo[];
  answers: QuestionAnswer[];
  rejected: boolean;
}

export function normalizeQuestions(input: QuestionParamsType): QuestionInfo[] {
  return (input.questions ?? []).map((q) => ({
    ...q,
    options: q.options ?? [],
  }));
}

export function validateQuestions(questions: QuestionInfo[]): void {
  if (!questions.length) throw new Error("question requires at least one question.");
  for (const [index, question] of questions.entries()) {
    if (!question.question?.trim()) throw new Error(`question ${index + 1} requires question text.`);
    if (!question.header?.trim()) throw new Error(`question ${index + 1} requires a header.`);
    if (question.header.trim().length > 30) throw new Error(`question ${index + 1} header must be 30 characters or fewer.`);
    const labels = new Set<string>();
    for (const [optionIndex, option] of (question.options ?? []).entries()) {
      const label = option.label?.trim();
      if (!label) throw new Error(`question ${index + 1} option ${optionIndex + 1} requires a label.`);
      if (!option.description?.trim()) throw new Error(`question ${index + 1} option ${optionIndex + 1} requires a description.`);
      const key = label.toLowerCase();
      if (labels.has(key)) throw new Error(`question ${index + 1} has duplicate option label: ${label}`);
      labels.add(key);
    }
  }
}
