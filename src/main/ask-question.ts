/**
 * `ask_question` tool — puts a multiple-choice question to the user and blocks
 * until they answer, so the agent can settle a decision that is genuinely theirs
 * instead of guessing and building the wrong thing.
 *
 * The call blocks the same way an approval does: the request goes to the
 * renderer, the tool waits, and the answer comes back as the tool result.
 */
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { QuestionAnswer, QuestionItem } from "../shared/ipc.js";

const askQuestionSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({
        description: "The question to ask. Specific, and answerable by the options given.",
      }),
      header: Type.String({
        description: 'Very short label shown as a chip, max 12 chars, e.g. "Database".',
      }),
      multiSelect: Type.Boolean({
        description: "Whether the user may pick more than one option.",
      }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "The choice itself, 1-5 words." }),
          description: Type.String({
            description: "What picking this means, or what it trades away.",
          }),
        }),
        {
          minItems: 2,
          maxItems: 4,
          description:
            'Distinct choices. Do not add an "Other" option — the user always gets one.',
        },
      ),
    }),
    { minItems: 1, maxItems: 4, description: "Up to 4 questions, asked together." },
  ),
});

interface AskQuestionInput {
  questions: QuestionItem[];
}

export interface AskQuestionDetails {
  answers: QuestionAnswer[];
  /** False when the user dismissed the question instead of answering. */
  answered: boolean;
}

/** Puts the question to the user and resolves once they answer or dismiss it. */
export type AskQuestionFn = (
  toolCallId: string,
  questions: QuestionItem[],
  signal: AbortSignal | undefined,
) => Promise<QuestionAnswer[]>;

export function createAskQuestionTool(
  ask: AskQuestionFn,
): AgentHarnessTool<{ env: unknown }, typeof askQuestionSchema, AskQuestionDetails> {
  return {
    name: "ask_question",
    label: "ask question",
    description:
      "Ask the user to decide something, offering 2-4 concrete options per question. " +
      "Use it only when the answer is genuinely the user's to give: a choice you cannot " +
      "settle from the request, the code, or a sensible default, and where different " +
      "answers lead to materially different work. Do not use it for questions you can " +
      "answer yourself by reading the codebase, for confirmation of an obvious default, " +
      "or to report progress. The user can always answer in their own words instead of " +
      "picking, so treat the options as suggestions rather than the only outcomes.",
    parameters: askQuestionSchema,
    async execute(toolCallId, params: AskQuestionInput, signal) {
      const questions = (params.questions ?? []).map((question) => ({
        ...question,
        multiSelect: question.multiSelect === true,
        options: question.options ?? [],
      }));
      if (questions.length === 0) {
        return {
          content: [{ type: "text", text: "No questions were provided, so nothing was asked." }],
          isError: true,
          details: { answers: [], answered: false },
        };
      }

      const answers = await ask(toolCallId, questions, signal);
      if (answers.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "The user dismissed the question without answering. Proceed with your best judgment, and say which assumption you made.",
            },
          ],
          details: { answers: [], answered: false },
        };
      }

      const text = answers
        .map((answer) => `${answer.question}\n${answer.selected.join(", ")}`)
        .join("\n\n");
      return {
        content: [{ type: "text", text: `The user answered:\n\n${text}` }],
        details: { answers, answered: true },
      };
    },
  };
}
