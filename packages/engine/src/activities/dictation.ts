import { gradeDictation } from '../grading';
import type { LearnerModel } from '../learner';
import type { ActivitySpec, DictationSentence, Item, Purpose } from '../types';
import { hash } from './util';
import type { ActivityType, Ordered } from './types';

type Spec = Extract<ActivitySpec, { type: 'dictation' }>;

/** Taught (a review card for reading or writing) and holding for recognition: fit to appear in a dictation. */
export function readyForDictation(model: LearnerModel, itemId: string): boolean {
  const taught = (['read', 'write'] as const).some((skill) => !!model.state(itemId, skill).card);
  return taught && model.pKnown(itemId, 'read') >= model.config.planner.prerequisiteMin;
}

const tracked = (s: DictationSentence) => [...new Set(s.segments.flatMap((g) => (g.itemId ? [g.itemId] : [])))];

function sentenceFor(model: LearnerModel, sessionId: string, itemId: string): DictationSentence | null {
  const usable = model.catalog.sentencesWith(itemId).filter((s) => tracked(s).every((id) => readyForDictation(model, id)));
  if (usable.length === 0) return null;
  const uses = new Map<string, number>();
  for (const a of model.activities.values()) {
    if (a.spec.type === 'dictation') uses.set(a.spec.sentenceId, (uses.get(a.spec.sentenceId) ?? 0) + 1);
  }
  const rank = (s: DictationSentence) => (uses.get(s.id) ?? 0) * 1e10 + hash(`${sessionId}:${itemId}:${s.id}`);
  return usable.sort((x, y) => rank(x) - rank(y))[0]!;
}

/** Words with a review card for reading or writing, in teaching order. Drawn from learner state, which is sparse. */
function taughtWords(model: LearnerModel): Item[] {
  const ids = new Set<string>();
  for (const s of model.states.values()) if (s.card && (s.skill === 'read' || s.skill === 'write')) ids.add(s.itemId);
  return [...ids]
    .map((id) => model.item(id))
    .filter((i): i is Item => i?.type === 'vocab')
    .sort((a, b) => a.order - b.order);
}

function spec(model: LearnerModel, sessionId: string, item: Item, purpose: Purpose): Spec | null {
  const s = sentenceFor(model, sessionId, item.id);
  return s ? { type: 'dictation', itemId: item.id, purpose, sentenceId: s.id, segments: s.segments } : null;
}

const FIRST_LISTEN_SCORE = 32;
const FIRST_LISTEN_PER_PLAN = 3;

/** Plays a short sentence made of words you know; you type what you hear, compared by reading. */
export const dictation: ActivityType<Spec> = {
  id: 'dictation',
  strand: 'input',
  grading: 'code',
  closed: true,
  skills: ['listen'],
  stages: [1, 2, 3],
  expectedSeconds: (spec, _item, config) =>
    config.timing.baseSeconds.dictation +
    config.timing.perCharSeconds * [...spec.segments.map((s) => s.reading).join('')].length,
  skillOf: () => 'listen',

  candidates(ctx) {
    const { model, sessionId } = ctx;
    const out: Ordered[] = ctx.needs.flatMap((n, order) => {
      if (n.teach || n.item.type !== 'vocab' || n.skill !== 'listen') return [];
      const s = spec(model, sessionId, n.item, n.purpose);
      return s ? [{ spec: s, score: n.score, reason: n.reason, order }] : [];
    });
    // Words you read well but have never been asked to hear.
    const fresh = taughtWords(model)
      .filter((i) => i.skills.includes('listen'))
      .filter((i) => !ctx.metThisSession.has(i.id) && !ctx.recentItems.has(i.id))
      .filter((i) => !model.state(i.id, 'listen').card && readyForDictation(model, i.id));
    let k = 0;
    for (const item of fresh) {
      if (k >= FIRST_LISTEN_PER_PLAN) break;
      const s = spec(model, sessionId, item, 'first_listen');
      if (!s) continue;
      out.push({ spec: s, score: FIRST_LISTEN_SCORE - k, reason: 'first time by ear', order: ctx.needs.length + k });
      k++;
    }
    return out;
  },

  respond(e, a, ctx) {
    if (e.kind === 'choice') return { kind: 'none' };
    const items = [...new Set(a.spec.segments.flatMap((g) => (g.itemId ? [g.itemId] : [])))]
      .map((id) => ctx.item(id))
      .filter((i): i is Item => !!i);
    const expected = a.spec.segments.map((s) => s.text).join('');
    const opts = { context: 'dictation' };
    const target = a.spec.itemId;

    if (e.kind === 'dont_know') {
      if (a.spec.purpose === 'review') ctx.reviewOutcome(false);
      for (const item of items) ctx.emit(item, 'listen', 'negative', ctx.config.strengths.dontKnow, e.latencyMs, opts);
      for (const item of items) ctx.expose(item.id);
      a.outcome = 'dont_know';
      return { kind: 'revealed', expected };
    }

    const g = gradeDictation(a.spec.segments, e.text);
    const correct = g.correct || ctx.disputed;
    a.attempts += 1;
    a.answers.push(e.text);
    const heard = new Map<string, boolean>();
    a.spec.segments.forEach((seg, i) => {
      if (seg.itemId) heard.set(seg.itemId, (heard.get(seg.itemId) ?? true) && (correct || g.heard[i]!));
    });
    if (a.spec.purpose === 'review') ctx.reviewOutcome(heard.get(target) ?? correct);
    for (const item of items) {
      const ok = heard.get(item.id) ?? false;
      ctx.emit(item, 'listen', ok ? 'positive' : 'negative', ctx.config.strengths.dictationItem, e.latencyMs, opts);
    }
    for (const item of items) ctx.expose(item.id);
    // The outcome is the target word's: other words missed in the sentence keep their own negative evidence.
    a.outcome = (heard.get(target) ?? correct) ? 'correct' : 'wrong';
    return correct ? { kind: 'correct', expected } : { kind: 'incorrect', expected, canDispute: true };
  },
};
