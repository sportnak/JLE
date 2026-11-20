import type { ActivitySpec } from '../types';
import { eligiblePairs } from './minimalPair';
import type { ActivityType } from './types';

type Spec = Extract<ActivitySpec, { type: 'introduce' }>;

/** Shows and plays a new item. Gives no evidence; the attempt that follows does. */
export const introduce: ActivityType<Spec> = {
  id: 'introduce',
  strand: 'study',
  grading: 'code',
  closed: false,
  skills: [],
  stages: [1, 2, 3, 4],
  expectedSeconds: (_spec, item, config) =>
    config.timing.baseSeconds.introduce + config.timing.perCharSeconds * (item ? [...item.reading].length : 1),
  skillOf: () => null,

  candidates: (ctx) =>
    ctx.needs.flatMap((n, order) => {
      if (!n.teach) return [];
      if (n.item.type !== 'sound') return [{ spec: { type: 'introduce', itemId: n.item.id }, score: n.score, reason: n.reason, order }];
      // A sound feature is taught with the pair that was just missed, or any pair the learner can read.
      const missed = ctx.sessionActs.findLast((a) => a.spec.type === 'minimal_pair' && a.spec.itemId === n.item.id);
      const pairId = missed?.spec.type === 'minimal_pair' ? missed.spec.pairId : eligiblePairs(ctx.model, n.item.id)[0]?.id;
      if (!pairId) return [];
      return [{ spec: { type: 'introduce', itemId: n.item.id, pairId }, score: n.score, reason: n.reason, order }];
    }),
};
