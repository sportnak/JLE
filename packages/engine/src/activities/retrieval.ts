import { grade } from '../grading';
import { CUE_SKILL, type ActivitySpec, type Cue, type Item, type Skill } from '../types';
import type { ActivityType } from './types';

type Spec = Extract<ActivitySpec, { type: 'retrieval' }>;

export function cueFor(item: Item, skill: Skill): Cue {
  if (item.type === 'script') return 'kana_to_reading';
  return skill === 'write' ? 'en_to_ja' : 'ja_to_en';
}

export function retrievalSpec(item: Item, skill: Skill, purpose: Spec['purpose']): Spec {
  const cue = cueFor(item, skill);
  return {
    type: 'retrieval',
    itemId: item.id,
    cue,
    purpose,
    showFurigana: cue === 'ja_to_en' && item.written !== item.reading,
  };
}

// Sound features have minimal pairs and grammar points have contrast choice; neither is a word to translate.
const serves = (item: Item, skill: Skill) => item.type !== 'sound' && item.type !== 'grammar' && (skill === 'read' || skill === 'write');

/** One item and a cue; the answer is typed and checked by string and reading. */
export const retrieval: ActivityType<Spec> = {
  id: 'retrieval',
  strand: 'study',
  grading: 'code',
  closed: true,
  skills: ['read', 'write'],
  stages: [1, 2, 3, 4],
  expectedSeconds: (spec, item, config) =>
    config.timing.baseSeconds[spec.cue] + config.timing.perCharSeconds * (item ? [...item.reading].length : 1),
  skillOf: (spec) => CUE_SKILL[spec.cue],

  candidates: (ctx) =>
    ctx.needs.flatMap((n, order) =>
      !n.teach && serves(n.item, n.skill)
        ? [{ spec: retrievalSpec(n.item, n.skill, n.purpose), score: n.score, reason: n.reason, order }]
        : [],
    ),

  respond(e, a, ctx) {
    const spec = a.spec;
    const item = ctx.item(spec.itemId);
    if (!item || e.kind === 'choice') return { kind: 'none' };
    const skill = CUE_SKILL[spec.cue];
    const production = skill === 'write' || skill === 'speak';
    const s = ctx.config.strengths;
    const opts = {
      context: spec.cue,
      support: spec.showFurigana && spec.cue === 'ja_to_en' && item.written !== item.reading,
    };

    if (e.kind === 'dont_know') {
      const expected = grade(item, spec.cue, '').expected;
      if (!a.nudged) {
        ctx.firstOutcome(item.id, false);
        if (spec.purpose === 'review') ctx.reviewOutcome(false);
        ctx.emit(item, skill, 'negative', s.dontKnow, e.latencyMs, opts);
        a.outcome = 'dont_know';
      }
      ctx.expose(item.id);
      return { kind: 'revealed', expected };
    }

    const g = grade(item, spec.cue, e.text);
    const correct = g.correct || ctx.disputed;
    a.attempts += 1;
    a.answers.push(e.text);

    if (a.nudged) {
      if (correct) {
        ctx.emit(item, skill, 'positive', s.selfCorrect, e.latencyMs, { ...opts, fsrs: null });
        a.outcome = 'self_corrected';
        ctx.expose(item.id);
        return { kind: 'correct', expected: g.expected, note: 'Fixed it.' };
      }
      ctx.expose(item.id);
      return { kind: 'incorrect', expected: g.expected, note: g.note, canDispute: true };
    }

    ctx.firstOutcome(item.id, correct);
    if (spec.purpose === 'review') ctx.reviewOutcome(correct);

    if (correct) {
      ctx.emit(item, skill, 'positive', production ? s.promptedProductionCorrect : s.recognitionAnswer, e.latencyMs, opts);
      a.outcome = 'correct';
      ctx.expose(item.id);
      return { kind: 'correct', expected: g.expected, note: g.note };
    }

    const known = ['known', 'maintained'].includes(ctx.state(item.id, skill).status);
    ctx.emit(item, skill, 'negative', production ? s.productionWrong : s.recognitionAnswer, e.latencyMs, opts);
    a.outcome = 'wrong';
    if (known && production) {
      a.nudged = true;
      return { kind: 'retry', message: 'You know this one. Have another look.' };
    }
    ctx.expose(item.id);
    return { kind: 'incorrect', expected: g.expected, note: g.note, canDispute: true };
  },
};
