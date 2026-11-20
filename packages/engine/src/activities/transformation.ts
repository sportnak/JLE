import { inflections, type Pos } from '../conjugate';
import { normalizeReading } from '../grading';
import type { ActivitySpec, Item } from '../types';
import { hash } from './util';
import type { ActivityType, Ordered } from './types';

type Spec = Extract<ActivitySpec, { type: 'transformation' }>;

const SCORE = 40;
const PER_PLAN = 2;

/** Forms asked for. Plain affirmative is the dictionary form itself, so it is never asked. */
function formsFor(pos: Pos): string[] {
  const all = inflections('する', 'vs').map((f) => f.label);
  if (pos === 'adj-i' || pos === 'adj-ii' || pos === 'adj-na') return inflections(pos === 'adj-na' ? '静か' : '高い', pos).map((f) => f.label);
  // ありたい is not something a learner should be asked for. ある's negative (ない) is, and the conjugator has it.
  return pos === 'v5-aru' ? all.filter((l) => l !== 'たい form') : all;
}

/** The spec for asking `form` of a word: accepted answers come from the conjugator, never from a model. */
export function transformationSpec(item: Item, form: string): Spec | null {
  if (!item.pos) return null;
  const expected = [item.written, item.reading]
    .map((base) => inflections(base, item.pos!).find((f) => f.label === form)?.text)
    .filter((t): t is string => !!t);
  if (expected.length === 0) return null;
  return { type: 'transformation', itemId: item.id, purpose: 'practice', form, expected: [...new Set(expected)] };
}

/** Make a form of a word that has been taught: polite past of 食べる, negative of 静か. Graded by the conjugator. */
export const transformation: ActivityType<Spec> = {
  id: 'transformation',
  strand: 'study',
  grading: 'code',
  closed: true,
  skills: ['write'],
  stages: [2, 3, 4],
  expectedSeconds: (spec, _item, config) =>
    config.timing.baseSeconds.transformation + config.timing.perCharSeconds * [...(spec.expected[0] ?? '')].length,
  skillOf: () => 'write',

  candidates(ctx): Ordered[] {
    const { model } = ctx;
    const done = [...model.activities.values()].filter((a) => a.spec.type === 'transformation').length;
    // Words taught for production, least recently practised first.
    const words = [...model.states.values()]
      .filter((s) => s.skill === 'write' && s.card)
      .map((s) => ({ s, item: model.item(s.itemId) }))
      .filter((x): x is { s: (typeof x)['s']; item: Item } => !!x.item?.pos && !ctx.metThisSession.has(x.item.id) && !ctx.recentItems.has(x.item.id))
      .sort((a, b) => (a.s.lastEvidenceAt ?? '').localeCompare(b.s.lastEvidenceAt ?? ''))
      .slice(0, PER_PLAN);
    return words.flatMap(({ item }, k): Ordered[] => {
      const forms = formsFor(item.pos!);
      const form = forms[hash(`${item.id}:${done + k}`) % forms.length]!;
      const spec = transformationSpec(item, form);
      return spec ? [{ spec, score: SCORE - k, reason: 'a form of a word you know', order: ctx.needs.length + k }] : [];
    });
  },

  respond(e, a, ctx) {
    if (e.kind === 'choice') return { kind: 'none' };
    const item = ctx.item(a.spec.itemId);
    const expected = a.spec.expected[0] ?? '';
    const opts = { context: 'transformation', fsrs: null };
    if (e.kind === 'dont_know') {
      if (item) ctx.emit(item, 'write', 'negative', ctx.config.strengths.transformation, e.latencyMs, opts);
      a.outcome = 'dont_know';
      return { kind: 'revealed', expected };
    }
    const given = normalizeReading(e.text);
    const correct = ctx.disputed || a.spec.expected.some((x) => normalizeReading(x) === given);
    a.attempts += 1;
    a.answers.push(e.text);
    if (item) ctx.emit(item, 'write', correct ? 'positive' : 'negative', ctx.config.strengths.transformation, e.latencyMs, opts);
    a.outcome = correct ? 'correct' : 'wrong';
    return correct ? { kind: 'correct', expected } : { kind: 'incorrect', expected, canDispute: true };
  },
};
