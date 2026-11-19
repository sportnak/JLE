import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config';
import { applyEvidence, createScheduler, emptyState, nextStatus, reviewCard, type Scheduler } from '../src/model';
import type { EvidenceEvent, ItemSkillState } from '../src/types';

let scheduler: Scheduler;
beforeAll(async () => {
  scheduler = await createScheduler(DEFAULT_CONFIG);
});

const ev = (direction: 'positive' | 'negative', strength: number, context = 'c1'): EvidenceEvent => ({
  interactionId: 'x',
  itemId: 'i',
  skill: 'write',
  direction,
  strength,
  baseStrength: strength,
  context,
  rulesVersion: 'test',
  fsrsGrade: direction === 'positive' ? 'good' : 'again',
});

const learning = { status: 'learning' as const, card: { stability: 1 } as never };
const state = (patch: Partial<ItemSkillState>): ItemSkillState => ({ ...emptyState('i', 'write'), ...learning, ...patch });

describe('nextStatus (PRD status table)', () => {
  const base = { lapse: false, direct: true };
  it.each<[string, Partial<ItemSkillState>, { lapse: boolean; direct: boolean }, ItemSkillState['status']]>([
    ['mixed evidence → learning', { pKnown: 0.6, contexts: ['a'], evidenceDays: ['d1'] }, base, 'learning'],
    ['high p but one context → learning', { pKnown: 0.9, contexts: ['a'], evidenceDays: ['d1', 'd2'] }, base, 'learning'],
    ['high p but one day → learning', { pKnown: 0.9, contexts: ['a', 'b'], evidenceDays: ['d1'] }, base, 'learning'],
    ['p ≥ 0.85, 2 contexts, 2 days → known', { pKnown: 0.9, contexts: ['a', 'b'], evidenceDays: ['d1', 'd2'] }, base, 'known'],
    [
      'known with stability ≥ 30 → maintained',
      { pKnown: 0.9, contexts: ['a', 'b'], evidenceDays: ['d1', 'd2'], card: { stability: 31 } as never },
      base,
      'maintained',
    ],
    ['pending confirm blocks known', { pKnown: 0.95, contexts: ['a', 'b'], evidenceDays: ['d1', 'd2'], confirmDueAt: '2030-01-01' }, base, 'learning'],
    ['two negatives in a row → learning', { pKnown: 0.95, contexts: ['a', 'b'], evidenceDays: ['d1', 'd2'], negativeStreak: 2 }, base, 'learning'],
    ['lapse → learning', { pKnown: 0.95, contexts: ['a', 'b'], evidenceDays: ['d1', 'd2'] }, { lapse: true, direct: true }, 'learning'],
    ['4 lapses → leech', { lapses: 4 }, base, 'leech'],
    ['cross-skill evidence keeps unseen', { status: 'unseen', card: null, pKnown: 0.4 }, { lapse: false, direct: false }, 'unseen'],
    ['a miss on an untaught item → introduced', { status: 'unseen', card: null, pKnown: 0.2 }, base, 'introduced'],
  ])('%s', (_name, patch, event, expected) => {
    expect(nextStatus(state(patch), event, DEFAULT_CONFIG)).toBe(expected);
  });
});

describe('applyEvidence', () => {
  const ctx = (day: string, prior = 0.3) => ({ at: new Date(`${day}T10:00:00Z`), day, prior, direct: true });

  it('needs two days and two contexts before Known', () => {
    let s = emptyState('i', 'write');
    s = applyEvidence(s, ev('positive', 1, 'en_to_ja:2026-01-01'), ctx('2026-01-01'), scheduler, DEFAULT_CONFIG);
    s = applyEvidence(s, ev('positive', 1, 'en_to_ja:2026-01-01'), ctx('2026-01-01'), scheduler, DEFAULT_CONFIG);
    expect(s.status).toBe('learning');
    s = applyEvidence(s, ev('positive', 1, 'en_to_ja:2026-01-02'), ctx('2026-01-02'), scheduler, DEFAULT_CONFIG);
    expect(s.pKnown).toBeGreaterThanOrEqual(0.85);
    expect(s.status).toBe('known');
  });

  it('counts a strong negative on a Known item as a lapse', () => {
    const card = reviewCard(scheduler, null, new Date('2026-01-01T10:00:00Z'), 'good');
    let s = state({ status: 'known', card, pos: 10, contexts: ['a', 'b'], evidenceDays: ['d1', 'd2'] });
    s = applyEvidence(s, ev('negative', 0.8), ctx('2026-01-03'), scheduler, DEFAULT_CONFIG);
    expect(s.lapses).toBe(1);
    expect(s.status).toBe('learning');
    expect(s.needsExplanation).toBe(true);
  });

  it('a miss on an untaught item creates no review card', () => {
    const s = applyEvidence(emptyState('i', 'write'), ev('negative', 0.7), ctx('2026-01-01'), scheduler, DEFAULT_CONFIG);
    expect(s.card).toBeNull();
    expect(s.status).toBe('introduced');
  });

  it('cross-skill evidence moves p_known without scheduling a review', () => {
    const s = applyEvidence(emptyState('i', 'read'), ev('positive', 0.5), { ...ctx('2026-01-01'), direct: false }, scheduler, DEFAULT_CONFIG);
    expect(s.card).toBeNull();
    expect(s.pKnown).toBeGreaterThan(0.3);
  });
});
