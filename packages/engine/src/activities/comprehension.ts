import type { ActivitySpec } from '../types';
import { hash } from './util';
import type { ActivityType, Ordered } from './types';

type Spec = Extract<ActivitySpec, { type: 'comprehension' }>;

/** Asked straight after the passage, before anything else. */
const AFTER_READING_SCORE = 900;

/**
 * Multiple-choice questions on the passage just read. A question that hinges on a word gives recognition evidence for
 * that word; one without a hinge only checks the gist and gives none.
 */
export const comprehension: ActivityType<Spec> = {
  id: 'comprehension',
  strand: 'input',
  grading: 'code',
  closed: true,
  skills: ['read'],
  stages: [1, 2, 3, 4],
  expectedSeconds: (spec, _item, config) =>
    config.timing.baseSeconds.comprehension + config.timing.readingPerCharSeconds * [...spec.prompt, ...spec.options.join('')].length * 0.25,
  skillOf: (spec) => (spec.hinge ? 'read' : null),

  candidates(ctx): Ordered[] {
    const last = ctx.sessionActs.findLast((a) => a.spec.type === 'reading' && a.outcome);
    if (!last || last.spec.type !== 'reading') return [];
    const contentId = last.spec.contentId;
    const content = ctx.model.contents.get(contentId);
    const asked = new Set(
      ctx.sessionActs.filter((a) => a.spec.type === 'comprehension' && a.spec.contentId === contentId && a.index > last.index).map((a) => (a.spec.type === 'comprehension' ? a.spec.question : -1)),
    );
    const fallback = content?.tokens.find((t) => t.itemId && ctx.model.item(t.itemId))?.itemId;
    return (content?.questions ?? []).flatMap((q, i): Ordered[] => {
      if (asked.has(i)) return [];
      const hinge = !!q.itemId && !!ctx.model.item(q.itemId);
      const itemId = hinge ? q.itemId! : fallback;
      const answer = q.options[q.answer];
      if (!itemId || answer === undefined) return [];
      // Shown in an order fixed by the passage and question, so replay shows the same.
      const shift = hash(`${contentId}:${i}`) % q.options.length;
      const options = [...q.options.slice(shift), ...q.options.slice(0, shift)];
      return [
        {
          spec: { type: 'comprehension', itemId, purpose: 'practice', contentId, question: i, prompt: q.prompt, options, answer, hinge },
          score: AFTER_READING_SCORE - i,
          reason: 'about what you just read',
          order: i,
        },
      ];
    });
  },

  respond(e, a, ctx) {
    if (e.kind === 'answer') return { kind: 'none' };
    const item = ctx.item(a.spec.itemId);
    const expected = a.spec.answer;
    const opts = { context: 'comprehension', fsrs: null };
    if (e.kind === 'dont_know') {
      if (a.spec.hinge && item) ctx.emit(item, 'read', 'negative', ctx.config.strengths.comprehension, e.latencyMs, opts);
      a.outcome = 'dont_know';
      return { kind: 'revealed', expected };
    }
    const correct = e.choice === expected;
    a.attempts += 1;
    a.answers.push(e.choice);
    if (a.spec.hinge && item) ctx.emit(item, 'read', correct ? 'positive' : 'negative', ctx.config.strengths.comprehension, e.latencyMs, opts);
    a.outcome = correct ? 'correct' : 'wrong';
    return correct ? { kind: 'correct', expected } : { kind: 'incorrect', expected, canDispute: false };
  },
};
