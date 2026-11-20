import { gradeMinimalPair } from '../grading';
import type { LearnerModel } from '../learner';
import type { ActivitySpec, MinimalPair } from '../types';
import { hash } from './util';
import type { ActivityType } from './types';

type Spec = Extract<ActivitySpec, { type: 'minimal_pair' }>;

/** Pairs for a sound feature whose kana the learner can already read. */
export function eligiblePairs(model: LearnerModel, itemId: string): MinimalPair[] {
  const min = model.config.planner.prerequisiteMin;
  return (model.catalog.pairs ?? []).filter(
    (p) => p.itemId === itemId && p.kana.every((k) => model.pKnown(k, 'read') >= min),
  );
}

function pairSpec(model: LearnerModel, sessionId: string, itemId: string, purpose: Spec['purpose']): Spec | null {
  const pairs = eligiblePairs(model, itemId);
  if (pairs.length === 0) return null;
  const done = [...model.activities.values()].filter((a) => a.spec.type === 'minimal_pair' && a.spec.itemId === itemId).length;
  const pair = pairs[(hash(itemId) + done) % pairs.length]!;
  const seed = hash(`${sessionId}:${pair.id}:${done}`);
  const options: [string, string] = seed & 1 ? [pair.b.kana, pair.a.kana] : [pair.a.kana, pair.b.kana];
  return { type: 'minimal_pair', itemId, purpose, pairId: pair.id, options, answer: seed & 2 ? pair.b.kana : pair.a.kana };
}

/** Plays one word of a pair; the learner picks which of the two it was. */
export const minimalPair: ActivityType<Spec> = {
  id: 'minimal_pair',
  strand: 'study',
  grading: 'code',
  closed: true,
  skills: ['listen'],
  stages: [1, 2],
  expectedSeconds: (spec, _item, config) =>
    config.timing.baseSeconds.minimal_pair + config.timing.perCharSeconds * [...spec.answer].length,
  skillOf: () => 'listen',

  candidates: (ctx) =>
    ctx.needs.flatMap((n, order) => {
      if (n.teach || n.item.type !== 'sound' || n.skill !== 'listen') return [];
      const spec = pairSpec(ctx.model, ctx.sessionId, n.item.id, n.purpose);
      return spec ? [{ spec, score: n.score, reason: n.reason, order }] : [];
    }),

  respond(e, a, ctx) {
    const item = ctx.item(a.spec.itemId);
    if (!item || e.kind === 'answer') return { kind: 'none' };
    const expected = a.spec.answer;
    const opts = { context: 'minimal_pair' };
    if (e.kind === 'dont_know') {
      if (a.spec.purpose === 'review') ctx.reviewOutcome(false);
      ctx.emit(item, 'listen', 'negative', ctx.config.strengths.dontKnow, e.latencyMs, opts);
      a.outcome = 'dont_know';
      ctx.expose(item.id);
      return { kind: 'revealed', expected };
    }
    const g = gradeMinimalPair(a.spec, e.choice);
    a.attempts += 1;
    a.answers.push(e.choice);
    if (a.spec.purpose === 'review') ctx.reviewOutcome(g.correct);
    ctx.emit(item, 'listen', g.correct ? 'positive' : 'negative', ctx.config.strengths.minimalPairChoice, e.latencyMs, opts);
    a.outcome = g.correct ? 'correct' : 'wrong';
    ctx.expose(item.id);
    return g.correct ? { kind: 'correct', expected } : { kind: 'incorrect', expected, canDispute: false };
  },
};
