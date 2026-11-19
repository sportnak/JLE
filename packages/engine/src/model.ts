import { DefaultScheduler, Rating } from 'ts-fsrs';
import type { EngineConfig } from './config';
import type { EvidenceEvent, FsrsCard, ItemSkillState, Skill } from './types';

export type Scheduler = Awaited<ReturnType<typeof DefaultScheduler>>;

export async function createScheduler(config: EngineConfig): Promise<Scheduler> {
  return DefaultScheduler({ desiredRetention: config.fsrs.desiredRetention, enableFuzz: false });
}

export function emptyState(itemId: string, skill: Skill): ItemSkillState {
  return {
    itemId,
    skill,
    pos: 0,
    neg: 0,
    pKnown: 0,
    card: null,
    status: 'unseen',
    contexts: [],
    evidenceDays: [],
    lastEvidenceAt: null,
    lastDirection: null,
    negativeStreak: 0,
    lapses: 0,
    confirmDueAt: null,
    needsExplanation: false,
  };
}

export function pKnownOf(s: Pick<ItemSkillState, 'pos' | 'neg'>, prior: number, config: EngineConfig): number {
  const w = config.model.priorWeight;
  return (prior * w + s.pos) / (w + s.pos + s.neg);
}

function toCard(raw: Record<string, unknown>): FsrsCard {
  const { cardId: _ignored, ...rest } = raw;
  return rest as unknown as FsrsCard;
}

const GRADE = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good } as const;

export function reviewCard(scheduler: Scheduler, card: FsrsCard | null, at: Date, grade: keyof typeof GRADE): FsrsCard {
  const base = card ?? toCard(scheduler.newCard({ now: at }) as unknown as Record<string, unknown>);
  const result = scheduler.review({ card: { ...base, cardId: 'card' } as never, now: at, grade: GRADE[grade] });
  return toCard(result.card as unknown as Record<string, unknown>);
}

export function retrievability(scheduler: Scheduler, card: FsrsCard | null, at: Date): number {
  if (!card || !card.lastReviewAt) return 0;
  const elapsed = Math.max(0, scheduler.chrono.difference(card.lastReviewAt, at));
  return scheduler.model.forgettingCurve(card as never, elapsed);
}

export interface ApplyContext {
  at: Date;
  day: string;
  prior: number;
  direct: boolean;
}

/**
 * Applies one evidence event to an item-skill state. `direct` is false for
 * cross-skill evidence (production counted toward recognition), which moves
 * p_known but never schedules an FSRS review.
 */
export function applyEvidence(
  prev: ItemSkillState,
  ev: EvidenceEvent,
  ctx: ApplyContext,
  scheduler: Scheduler,
  config: EngineConfig,
): ItemSkillState {
  const m = config.model;
  const s: ItemSkillState = { ...prev, contexts: [...prev.contexts], evidenceDays: [...prev.evidenceDays] };
  const w = ev.strength * m.evidenceScale;
  const wasKnown = prev.status === 'known' || prev.status === 'maintained';

  if (ev.direction === 'positive') {
    s.pos += w;
    s.negativeStreak = 0;
  } else {
    s.neg += w;
    s.negativeStreak += 1;
  }
  if (ctx.direct && ev.direction === 'positive') {
    if (!s.contexts.includes(ev.context)) s.contexts.push(ev.context);
    if (!s.evidenceDays.includes(ctx.day)) s.evidenceDays.push(ctx.day);
  }
  s.lastEvidenceAt = ctx.at.toISOString();
  s.lastDirection = ev.direction;
  s.pKnown = pKnownOf(s, ctx.prior, config);

  // A miss on something never learned is a measurement, not a failed recall: no review card yet.
  if (ctx.direct && ev.fsrsGrade && (s.card || ev.direction === 'positive')) {
    s.card = reviewCard(scheduler, s.card, ctx.at, ev.fsrsGrade);
  }

  const lapse = ctx.direct && wasKnown && ev.direction === 'negative' && ev.strength >= m.lapseMinStrength;
  if (lapse) s.lapses += 1;
  if (ctx.direct && s.confirmDueAt && ctx.at.toISOString() >= s.confirmDueAt) s.confirmDueAt = null;

  s.status = nextStatus(s, { lapse, direct: ctx.direct }, config);
  if (s.negativeStreak >= 2 || lapse) s.needsExplanation = true;
  if (ev.direction === 'positive') s.needsExplanation = false;
  return s;
}

export function nextStatus(
  s: ItemSkillState,
  event: { lapse: boolean; direct: boolean },
  config: EngineConfig,
): ItemSkillState['status'] {
  const m = config.model;
  if (s.lapses >= m.leechLapses) return 'leech';
  if (event.lapse || s.negativeStreak >= 2) return 'learning';
  const known =
    s.pKnown >= m.knownThreshold &&
    s.contexts.length >= m.knownMinContexts &&
    s.evidenceDays.length >= m.knownMinDays &&
    s.confirmDueAt === null;
  if (known) return (s.card?.stability ?? 0) >= m.maintainedStabilityDays ? 'maintained' : 'known';
  const untaught = s.status === 'unseen' || s.status === 'introduced';
  if (untaught && !event.direct) return s.status;
  if (untaught && !s.card) return 'introduced';
  return 'learning';
}
