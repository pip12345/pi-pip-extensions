import type { QuestionAnswer, QuestionInfo } from "./schema.ts";

export function formatAnsweredOutput(questions: readonly QuestionInfo[], answers: readonly QuestionAnswer[]): string {
  const formatted = questions
    .map((q, index) => `"${q.question}"="${answers[index]?.length ? answers[index].join(", ") : "Unanswered"}"`)
    .join(", ");
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`;
}

export function formatRejectedOutput(): string {
  return "User dismissed the question. Continue without an answer, or ask in normal chat if this information is required.";
}

export function compactAnswers(questions: readonly QuestionInfo[], answers: readonly QuestionAnswer[]): string {
  if (!questions.length) return "No questions";
  return questions.map((q, index) => `${q.header}: ${answers[index]?.length ? answers[index].join(", ") : "(no answer)"}`).join("\n");
}
