import { normalizeReading } from '../grading';
import type { ActivitySpec } from '../types';
import type { ActivityType, Ordered } from './types';

type Spec = Extract<ActivitySpec, { type: 'cloze' }>;

/**
 * A sentence the learner kept, with one word blanked: type the word as it stands there. Offered in place of the bare
 * English cue when a word is due for production and appears in a kept sentence (sentence mining, architecture §4.7).
 */
export const cloze: ActivityType<Spec> = {
  id: 'cloze',
  strand: 'study',
  grading: 'code',
  closed: true,
  skills: ['write'],
  stages: [1, 2, 3, 4],
  expectedSeconds: (spec, _item, config) =>
    config.timing.baseSeconds.en_to_ja + config.timing.readingPerCharSeconds * [...spec.sentence].length,
  skillOf: () => 'write',

  candidates(ctx): Ordered[] {
    return ctx.needs.flatMap((n, order): Ordered[] => {
      if (n.teach || n.skill !== 'write' || n.item.type !== 'vocab') return [];
      const kept = ctx.model.keptWith(n.item.id)[0];
      const token = kept?.tokens.find((t) => t.itemId && ctx.model.catalog.resolve(t.itemId) === n.item.id);
      if (!kept || !token) return [];
      const spec: Spec = {
        type: 'cloze',
        itemId: n.item.id,
        purpose: n.purpose,
        contentId: kept.contentId,
        sentence: kept.text,
        blankBegin: token.begin - kept.begin,
        blankEnd: token.end - kept.begin,
        answers: [...new Set([token.surface, token.reading].filter(Boolean))],
      };
      // Just ahead of the plain retrieval for the same need, so the kept sentence is used.
      return [{ spec, score: n.score + 1, reason: `${n.reason}, in a sentence you kept`, order }];
    });
  },

  respond(e, a, ctx) {
    if (e.kind === 'choice') return { kind: 'none' };
    const item = ctx.item(a.spec.itemId);
    if (!item) return { kind: 'none' };
    const s = ctx.config.strengths;
    const expected = a.spec.answers[0] ?? '';
    const opts = { context: 'cloze' };
    if (e.kind === 'dont_know') {
      if (a.spec.purpose === 'review') ctx.reviewOutcome(false);
      ctx.emit(item, 'write', 'negative', s.dontKnow, e.latencyMs, opts);
      ctx.expose(item.id);
      a.outcome = 'dont_know';
      return { kind: 'revealed', expected };
    }
    const given = normalizeReading(e.text);
    const correct = ctx.disputed || a.spec.answers.some((x) => normalizeReading(x) === given);
    a.attempts += 1;
    a.answers.push(e.text);
    if (a.spec.purpose === 'review') ctx.reviewOutcome(correct);
    ctx.emit(item, 'write', correct ? 'positive' : 'negative', correct ? s.promptedProductionCorrect : s.productionWrong, e.latencyMs, opts);
    ctx.expose(item.id);
    a.outcome = correct ? 'correct' : 'wrong';
    return correct ? { kind: 'correct', expected } : { kind: 'incorrect', expected, canDispute: true };
  },
};
