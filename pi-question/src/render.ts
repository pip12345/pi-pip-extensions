import { Text } from "@earendil-works/pi-tui";
import { themeFg, truncateToWidth } from "../../pip-common/index.ts";
import { compactAnswers } from "./format.ts";
import type { QuestionInfo, QuestionResultDetails } from "./schema.ts";

function textResult(result: any): string {
  const block = result?.content?.find?.((item: any) => item?.type === "text");
  return block?.type === "text" ? block.text ?? "" : "";
}

export function renderQuestionCall(args: any, theme: any): Text {
  const questions = (args?.questions ?? []) as QuestionInfo[];
  const count = questions.length;
  const labels = questions.map((q) => q.header || q.question).filter(Boolean).join(", ");
  let text = themeFg(theme, "toolTitle", "question") + themeFg(theme, "muted", ` ${count} question${count === 1 ? "" : "s"}`);
  if (labels) text += themeFg(theme, "dim", ` (${truncateToWidth(labels, 48)})`);
  return new Text(text, 0, 0);
}

export function renderQuestionResult(result: any, _options: any, theme: any): Text {
  const details = result?.details as QuestionResultDetails | undefined;
  if (!details) return new Text(themeFg(theme, "muted", textResult(result)), 0, 0);
  if (details.rejected) return new Text(themeFg(theme, "warning", "Dismissed"), 0, 0);
  return new Text(themeFg(theme, "success", "✓ ") + themeFg(theme, "muted", compactAnswers(details.questions, details.answers)), 0, 0);
}
