import type { ActivitySpec } from '../types';
import type { ActivityType } from './types';

type Spec = Extract<ActivitySpec, { type: 'reading' }>;

const READING_SCORE = 45;
const REREAD_SCORE = 35;
const DAY_MS = 86_400_000;

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
    // One passage a lesson, except that a text the learner brought continues part after part while time allows.
    const lastHere = ctx.sessionActs.findLast((a) => a.spec.type === 'reading');
    const lastContent = lastHere?.spec.type === 'reading' ? ctx.model.contents.get(lastHere.spec.contentId) : undefined;
    const unread = ctx.model.unreadContent();
    if (lastHere) {
      const series = lastContent?.series;
      const nextPart = series && unread.find((c) => c.series?.id === series.id && c.series.part === series.part + 1);
      if (!nextPart || !lastHere.outcome) return [];
      const itemId = nextPart.tokens.find((t) => t.itemId && ctx.model.item(t.itemId))?.itemId;
      return itemId
        ? [{ spec: { type: 'reading', itemId, purpose: 'practice', contentId: nextPart.id, chars: [...nextPart.text].length }, score: READING_SCORE, reason: 'the next part of your text', order: ctx.needs.length }]
        : [];
    }
    // A new passage first; otherwise one read long enough ago to read again (rereading builds fluency).
    const fresh = unread[0];
    const lastRead = new Map<string, number>();
    for (const a of ctx.model.activities.values()) {
      if (a.spec.type !== 'reading' || !a.outcome) continue;
      lastRead.set(a.spec.contentId, Math.max(lastRead.get(a.spec.contentId) ?? 0, new Date(a.startedAt).getTime()));
    }
    const due = [...lastRead.entries()]
      .filter(([, at]) => ctx.now.getTime() - at >= ctx.model.config.reading.rereadAfterDays * DAY_MS)
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => ctx.model.contents.get(id))
      .find((c) => !!c);
    const next = fresh ?? due;
    if (!next) return [];
    const itemId = next.targets[0] ?? next.tokens.find((t) => t.itemId && ctx.model.item(t.itemId))?.itemId;
    if (!itemId || !ctx.model.item(itemId)) return [];
    return [
      {
        spec: { type: 'reading', itemId, purpose: 'practice', contentId: next.id, chars: [...next.text].length },
        score: fresh ? READING_SCORE : REREAD_SCORE,
        reason: fresh ? (next.source === 'library' ? 'a passage at your level' : 'a passage written for you') : 'read it again',
        order: ctx.needs.length,
      },
    ];
  },
};
