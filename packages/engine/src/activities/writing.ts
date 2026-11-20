import type { ActivitySpec, Item } from '../types';
import { hash } from './util';
import type { ActivityType, Ordered } from './types';

type Spec = Extract<ActivitySpec, { type: 'writing' }>;

const SCORE = 42;

/** Tasks in English, chosen in code. Short and everyday, so a learner at stage 3 can write something. */
export const WRITING_TASKS = [
  'Write two or three sentences about what you did last weekend.',
  'Describe your morning today.',
  'Write about a food you like and why.',
  'Describe your room or your home.',
  'Write about a friend or someone in your family.',
  'Write about what you will do tomorrow.',
  'Describe the weather today and what you did in it.',
  'Write about a place you would like to visit.',
  'Write about your favourite day of the week.',
  'Describe a shop or café near where you live.',
  'Write about something you bought recently.',
  'Write about a hobby or something you enjoy doing.',
  'Write a short note inviting a friend to do something.',
  'Write about what you usually eat for lunch.',
  'Describe how you get to work or school.',
  'Write about a book, film or song you like.',
];

/**
 * Free writing (architecture §6.3): a short task and two or three words to use, graded by the model. An answer gives no
 * evidence by itself; evidence comes only from the stored grade (LearnerModel, on `writing_graded`).
 */
export const writing: ActivityType<Spec> = {
  id: 'writing',
  strand: 'output',
  grading: 'model',
  closed: false,
  skills: ['write'],
  stages: [3, 4],
  expectedSeconds: (spec, _item, config) => config.timing.baseSeconds.writing + config.timing.perCharSeconds * 15 * spec.sentences,
  skillOf: () => 'write',

  candidates(ctx): Ordered[] {
    const { model } = ctx;
    if (ctx.sessionActs.some((a) => a.spec.type === 'writing')) return [];
    // Words taught for production, least recently practised first.
    const targets = [...model.states.values()]
      .filter((s) => s.skill === 'write' && s.card && (s.status === 'learning' || s.status === 'known'))
      .map((s) => ({ s, item: model.item(s.itemId) }))
      .filter((x): x is { s: (typeof x)['s']; item: Item } => x.item?.type === 'vocab' && !ctx.metThisSession.has(x.item.id))
      .sort((a, b) => (a.s.lastEvidenceAt ?? '').localeCompare(b.s.lastEvidenceAt ?? '') || a.item.id.localeCompare(b.item.id))
      .slice(0, 3)
      .map((x) => x.item);
    if (targets.length < 2) return [];
    const done = [...model.activities.values()].filter((a) => a.spec.type === 'writing').length;
    const h = hash(`${ctx.sessionId}:${done}`);
    const sentences = ctx.stage >= 4 ? 3 + (h % 3) : 2 + (h % 2);
    const spec: Spec = {
      type: 'writing',
      itemId: targets[0]!.id,
      purpose: 'practice',
      task: WRITING_TASKS[h % WRITING_TASKS.length]!,
      targets: targets.map((t) => t.id),
      sentences,
    };
    return [{ spec, score: SCORE, reason: 'write something of your own', order: ctx.needs.length }];
  },

  respond(e, a) {
    // The answer is graded by the model through Engine.submitWriting; nothing here gives evidence.
    if (e.kind === 'answer') {
      a.attempts += 1;
      a.answers.push(e.text);
    } else if (e.kind === 'dont_know' && !a.outcome) a.outcome = 'skip';
    return { kind: 'none' };
  },
};
