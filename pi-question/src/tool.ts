import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPipTool } from "../../pip-common/index.ts";
import { QuestionParams, normalizeQuestions, validateQuestions, type QuestionResultDetails } from "./schema.ts";
import { askQuestions } from "./ui.ts";
import { formatAnsweredOutput, formatRejectedOutput } from "./format.ts";
import { renderQuestionCall, renderQuestionResult } from "./render.ts";

const DESCRIPTION = "Ask the user questions during execution. Supports multiple questions, single or multiple choice, and optional custom answers.";

export function registerQuestionTool(pi: ExtensionAPI): void {
  registerPipTool(pi, {
    tool: {
      name: "question",
      label: "Question",
      description: DESCRIPTION,
      promptSnippet: "Ask the user one or more structured questions and wait for their answers.",
      promptGuidelines: [
        "Use question when you need user clarification, preferences, or decisions before continuing.",
        "Keep question options short and mutually exclusive; put the recommended option first and label it Recommended when useful.",
        "Do not include an Other option when question custom answers are enabled; the tool adds custom answer support automatically.",
      ],
      parameters: QuestionParams,
      async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
        const questions = normalizeQuestions(params);
        validateQuestions(questions);
        const result = await askQuestions(ctx, questions);
        const details: QuestionResultDetails = { questions, answers: result.answers, rejected: result.rejected };
        return {
          content: [{ type: "text" as const, text: result.rejected ? formatRejectedOutput() : formatAnsweredOutput(questions, result.answers) }],
          details,
        };
      },
      renderCall: renderQuestionCall,
      renderResult: renderQuestionResult,
    },
    metadata: {
      pluginId: "question",
      label: "Question",
    },
  });
}

export const __test = { DESCRIPTION };
