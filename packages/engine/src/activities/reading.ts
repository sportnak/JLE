import type { ActivitySpec } from '../types';
import type { ActivityType } from './types';

type Spec = Extract<ActivitySpec, { type: 'reading' }>;

const READING_SCORE = 45;

/**
 * A short passage written for the learner, read with furigana on unfamiliar words and tap-to-look-up.
 * Evidence comes from lookups and from finishing (see LearnerModel.onLookup and onReadingDone), not from an answer.
 */
export const reading: ActivityType<Spec> = {
  id: 'reading',
  strand: 'input',
  grading: 'code',
  closed: false,
  skills: ['read'],
  stages: [1, 2, 3, 4],
  expectedSeconds: (spec, _item, config) =>
    config.timing.baseSeconds.reading + config.timing.readingPerCharSeconds * spec.chars,
  skillOf: () => 'read',

  candidates(ctx) {
    if (ctx.sessionActs.some((a) => a.spec.type === 'reading')) return [];
    const next = ctx.model.unreadContent()[0];
    if (!next) return [];
    const itemId = next.targets[0] ?? next.tokens.find((t) => t.itemId)?.itemId;
    if (!itemId || !ctx.model.item(itemId)) return [];
    return [
      {
        spec: { type: 'reading', itemId, purpose: 'practice', contentId: next.id, chars: [...next.text].length },
        score: READING_SCORE,
        reason: 'a passage written for you',
        order: ctx.needs.length,
      },
    ];
  },
};
