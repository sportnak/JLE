import type { LlmRequest } from '../ports';
import type { GrammarContrast, GrammarPoint } from '../types';

export const EXPLAIN_PROMPT_VERSION = 'explain-1';

/**
 * Route `explain` (architecture §7.1): an explanation of one mistake, from the point's approved fact sheet only. The
 * stable part (these instructions) comes first and is cached; the sheet and the mistake follow.
 */
export const EXPLAIN_SYSTEM = `You explain one grammar mistake to someone learning Japanese at a beginner level.

You are given an approved fact sheet for the grammar point, a sentence with a gap, the form the learner chose, and the right form. Explain in two to four short sentences of plain English why the right form fits and why the learner's choice does not, using only what the fact sheet says. Quote the Japanese where it helps. Do not add rules, exceptions or examples that are not in the fact sheet, and do not use romaji.`;

export const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: { explanation: { type: 'string' } },
  required: ['explanation'],
  additionalProperties: false,
};

/** One explanation per point, fact sheet version, example and wrong answer: the same mistake is explained once. */
export const explanationKey = (point: GrammarPoint, example: number, wrong: string) => `${point.id}:v${point.version}:${example}:${wrong}`;

export function explainRequest(point: GrammarPoint, c: GrammarContrast, wrong: string): LlmRequest {
  return {
    promptVersion: EXPLAIN_PROMPT_VERSION,
    system: EXPLAIN_SYSTEM,
    user: [
      `Grammar point: ${point.label}`,
      `Fact sheet:\n${point.factSheet.body}`,
      `Sentence: ${c.sentence} (${c.translation})`,
      `The learner chose: ${wrong}`,
      `The right form: ${c.answer}`,
    ].join('\n\n'),
    schema: EXPLAIN_SCHEMA,
    maxTokens: 4000,
    effort: 'low',
  };
}
