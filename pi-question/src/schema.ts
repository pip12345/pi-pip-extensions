import { Type, type Static } from "typebox";

export const QUESTION_LIMITS = {
  questions: 8,
  options: 12,
  questionLength: 500,
  labelLength: 120,
  descriptionLength: 500,
} as const;

export const QuestionOptionSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: QUESTION_LIMITS.labelLength, description: "Display text (1-5 words, concise)" }),
  description: Type.String({ minLength: 1, maxLength: QUESTION_LIMITS.descriptionLength, description: "Explanation of choice" }),
});

export const QuestionInfoSchema = Type.Object({
  question: Type.String({ minLength: 1, maxLength: QUESTION_LIMITS.questionLength, description: "Complete question" }),
  header: Type.String({ minLength: 1, maxLength: 30, description: "Very short label (max 30 chars)" }),
  options: Type.Optional(Type.Array(QuestionOptionSchema, { maxItems: QUESTION_LIMITS.options, description: "Available choices" })),
  multiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple choices" })),
});

export const QuestionParams = Type.Object({
  questions: Type.Array(QuestionInfoSchema, { minItems: 1, maxItems: QUESTION_LIMITS.questions, description: "Questions to ask" }),
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
  if (questions.length > QUESTION_LIMITS.questions) throw new Error(`question accepts at most ${QUESTION_LIMITS.questions} questions.`);
  for (const [index, question] of questions.entries()) {
    if (!question.question?.trim()) throw new Error(`question ${index + 1} requires question text.`);
    if (question.question.length > QUESTION_LIMITS.questionLength) throw new Error(`question ${index + 1} text must be ${QUESTION_LIMITS.questionLength} characters or fewer.`);
    if (!question.header?.trim()) throw new Error(`question ${index + 1} requires a header.`);
    if (question.header.length > 30) throw new Error(`question ${index + 1} header must be 30 characters or fewer.`);
    const options = question.options ?? [];
    if (options.length > QUESTION_LIMITS.options) throw new Error(`question ${index + 1} accepts at most ${QUESTION_LIMITS.options} options.`);
    const labels = new Set<string>();
    for (const [optionIndex, option] of options.entries()) {
      const label = option.label?.trim();
      if (!label) throw new Error(`question ${index + 1} option ${optionIndex + 1} requires a label.`);
      if (option.label.length > QUESTION_LIMITS.labelLength) throw new Error(`question ${index + 1} option ${optionIndex + 1} label must be ${QUESTION_LIMITS.labelLength} characters or fewer.`);
      if (!option.description?.trim()) throw new Error(`question ${index + 1} option ${optionIndex + 1} requires a description.`);
      if (option.description.length > QUESTION_LIMITS.descriptionLength) throw new Error(`question ${index + 1} option ${optionIndex + 1} description must be ${QUESTION_LIMITS.descriptionLength} characters or fewer.`);
      const key = label.toLowerCase();
      if (labels.has(key)) throw new Error(`question ${index + 1} has duplicate option label: ${label}`);
      labels.add(key);
    }
  }
}
