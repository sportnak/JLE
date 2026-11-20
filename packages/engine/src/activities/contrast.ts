import type { ActivitySpec, GrammarPoint } from '../types';
import { grammarItemId } from '../catalog';
import { hash } from './util';
import type { ActivityType, Ordered } from './types';

type Spec = Extract<ActivitySpec, { type: 'contrast' }>;

const NEW_POINT_SCORE = 32;

function contrastSpec(point: GrammarPoint, done: number): Spec | null {
  if (point.contrasts.length === 0) return null;
  const example = done % point.contrasts.length;
  const c = point.contrasts[example]!;
  const flip = hash(`${point.id}:${example}:${done}`) & 1;
  return {
    type: 'contrast',
    itemId: grammarItemId(point.id),
    purpose: 'practice',
    pointId: point.id,
    version: point.version,
    example,
    sentence: c.sentence,
    translation: c.translation,
    options: flip ? [c.other, c.answer] : [c.answer, c.other],
    answer: c.answer,
  };
}

/**
 * Contrast choice: a sentence with a gap and two forms that are easy to confuse (は or が, に or で). Only approved
 * grammar points are used; a wrong choice shows the point's approved fact sheet. From stage 2 (architecture §11).
 */
export const contrast: ActivityType<Spec> = {
  id: 'contrast',
  strand: 'study',
  grading: 'code',
  closed: true,
  skills: ['read'],
  stages: [2, 3, 4],
  expectedSeconds: (spec, _item, config) =>
    config.timing.baseSeconds.minimal_pair + config.timing.readingPerCharSeconds * [...spec.sentence].length,
  skillOf: () => 'read',

  candidates(ctx): Ordered[] {
    const { model } = ctx;
    const points = new Map(model.catalog.grammar().map((p) => [grammarItemId(p.id), p]));
    if (points.size === 0) return [];
    const done = (pointId: string) =>
      [...model.activities.values()].filter((a) => a.spec.type === 'contrast' && a.spec.pointId === pointId).length;
    // Points due or missed, as the planner found them.
    const out: Ordered[] = ctx.needs.flatMap((n, order): Ordered[] => {
      const point = points.get(n.item.id);
      const spec = point && contrastSpec(point, done(point.id));
      return spec ? [{ spec, score: n.score, reason: n.reason, order }] : [];
    });
    // One point not met yet, prerequisites first.
    if (ctx.sessionActs.slice(-3).some((a) => a.spec.type === 'contrast')) return out;
    const fresh = [...points.values()]
      .filter((p) => model.state(grammarItemId(p.id), 'read').status === 'unseen' && !ctx.metThisSession.has(grammarItemId(p.id)))
      .filter((p) => p.prerequisites.every((r) => !points.has(grammarItemId(r)) || model.state(grammarItemId(r), 'read').status !== 'unseen'))
      .sort((a, b) => (a.tags.genki ?? 99) - (b.tags.genki ?? 99))[0];
    const spec = fresh && contrastSpec(fresh, 0);
    if (spec) out.push({ spec, score: NEW_POINT_SCORE, reason: 'a grammar point', order: ctx.needs.length });
    return out;
  },

  respond(e, a, ctx) {
    if (e.kind === 'answer') return { kind: 'none' };
    const item = ctx.item(a.spec.itemId);
    const expected = a.spec.answer;
    const opts = { context: `contrast:${a.spec.pointId}` };
    if (e.kind === 'dont_know') {
      if (item) ctx.emit(item, 'read', 'negative', ctx.config.strengths.dontKnow, e.latencyMs, opts);
      a.outcome = 'dont_know';
      return { kind: 'revealed', expected };
    }
    const correct = e.choice === expected;
    a.attempts += 1;
    a.answers.push(e.choice);
    if (item) ctx.emit(item, 'read', correct ? 'positive' : 'negative', ctx.config.strengths.contrastChoice, e.latencyMs, opts);
    a.outcome = correct ? 'correct' : 'wrong';
    return correct ? { kind: 'correct', expected } : { kind: 'incorrect', expected, canDispute: false };
  },
};
