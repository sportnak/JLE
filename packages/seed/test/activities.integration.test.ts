import { describe, expect, it, vi } from 'vitest';
import { toRomaji } from 'wanakana';
import {
  activityTypes,
  derive,
  DEFAULT_CONFIG,
  Engine,
  MemoryEventStore,
  type ActivityView,
  type Clock,
  type Ids,
  type LearnerInput,
  type Llm,
  REGISTRY,
  typeOf,
} from '@jle/engine';
import { createScheduler } from '../../engine/src/model';
import { buildCatalog } from '../src/index';

const catalog = buildCatalog();
const item = (id: string) => catalog.item(id)!;

class FakeClock implements Clock {
  t = new Date('2026-11-01T09:00:00Z').getTime();
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t += ms;
  }
}

const seqIds = (): Ids => {
  let n = 0;
  return { next: () => `id-${++n}` };
};

/** Answers every activity type: right for what `knows` accepts, otherwise "I don't know". */
function answerFor(view: ActivityView, knows: (itemId: string) => boolean): LearnerInput | null {
  const spec = view.spec;
  switch (spec.type) {
    case 'introduce':
      return null;
    case 'minimal_pair':
      return knows(spec.itemId) ? { kind: 'choice', choice: spec.answer, latencyMs: 2000 } : { kind: 'dont_know', latencyMs: 3000 };
    case 'dictation': {
      const text = spec.segments.map((s) => (s.itemId && !knows(s.itemId) ? '' : toRomaji(s.reading))).join('');
      return { kind: 'answer', text, latencyMs: 6000 };
    }
    case 'retrieval':
      if (!knows(view.item.id)) return { kind: 'dont_know', latencyMs: 4000 };
      return { kind: 'answer', text: spec.cue === 'ja_to_en' ? view.item.gloss[0]! : toRomaji(view.item.reading), latencyMs: 2500 };
  }
}

async function setup(llm?: Llm) {
  const clock = new FakeClock();
  const store = new MemoryEventStore();
  const engine = await Engine.create({ catalog, store, learnerId: 'me', clock, ids: seqIds(), utcOffsetMinutes: 0, ...(llm ? { llm } : {}) });
  return { clock, store, engine };
}

/** One session a day for `n` days. */
async function days(engine: Engine, clock: FakeClock, knows: (id: string) => boolean, n = 8) {
  const sessions = [];
  for (let d = 0; d < n; d++) {
    if (d > 0) clock.advance(86_400_000);
    sessions.push(await runSession(engine, clock, knows));
  }
  return sessions;
}

async function runSession(engine: Engine, clock: FakeClock, knows: (id: string) => boolean, minutes = 15) {
  let { sessionId, next } = await engine.startSession(minutes);
  const seen: ActivityView[] = [];
  let guard = 0;
  while (!next.done && guard++ < 500) {
    const view = next.activity;
    seen.push(view);
    const input = answerFor(view, knows);
    if (input) await engine.recordInteraction(view.activityId, input);
    clock.advance(view.spec.type === 'dictation' ? 15_000 : 8_000);
    await engine.completeActivity(view.activityId);
    next = await engine.nextActivity(sessionId);
  }
  return { sessionId, seen, recap: next.done ? next.recap : null };
}

/**
 * Knows hiragana and the first 60 words, and learns anything once it has been shown. Hears long vowels
 * but not small っ until it has been taught.
 */
function stageOneLearner(engine: Engine) {
  return (id: string) => {
    const it = item(id);
    if (engine.learner.lastExposure.has(id) && it.type !== 'sound') return true;
    if (it.type === 'script') return it.cluster.startsWith('hiragana');
    if (it.type === 'vocab') return (it.tags.freq ?? 999) <= 60;
    return id === 'sound:vowel-length' || engine.learner.lastExposure.has(id);
  };
}

function expectNoLoops(engine: Engine, seen: ActivityView[]) {
  const acts = seen.map((v) => engine.learner.activities.get(v.activityId)!);
  const byItem = new Map<string, typeof acts>();
  for (const a of acts) byItem.set(a.spec.itemId, [...(byItem.get(a.spec.itemId) ?? []), a]);
  for (const [itemId, list] of byItem) {
    const misses = list.filter((a) => a.outcome === 'wrong' || a.outcome === 'dont_know').length;
    const attempts = list.filter((a) => a.spec.type !== 'introduce').length;
    if (misses === 0) expect(attempts, `${itemId} re-asked without a miss`).toBeLessThanOrEqual(2);
    else expect(attempts, `${itemId} looped`).toBeLessThanOrEqual(2 + misses + 1);
  }
}

describe('a stage-1 session', () => {
  it('includes minimal pairs and dictation, and still has no loops', async () => {
    const { clock, engine } = await setup();
    const knows = stageOneLearner(engine);
    const sessions = await days(engine, clock, knows);

    expect(engine.stage()).toBe(1);
    const both = sessions.find(({ seen }) => {
      const types = seen.map((v) => v.spec.type);
      return types.includes('minimal_pair') && types.includes('dictation');
    });
    expect(both, 'a session with minimal pairs and dictation').toBeDefined();
    for (const { seen } of sessions) expectNoLoops(engine, seen);

    // The missed sound feature was taught with its pair, then tried again at once.
    const all = [...engine.learner.activities.values()];
    const taught = all.findIndex((a) => a.spec.type === 'introduce' && a.spec.itemId === 'sound:sokuon');
    expect(taught).toBeGreaterThan(-1);
    expect(all[taught]!.spec).toMatchObject({ pairId: expect.stringMatching(/^pair:/) });
    expect(all[taught + 1]!.spec).toMatchObject({ type: 'minimal_pair', itemId: 'sound:sokuon' });

    // Listening evidence lands on the sound feature and on every word in a dictation.
    expect(engine.learner.state('sound:vowel-length', 'listen').pos).toBeGreaterThan(0);
    const dict = all.find((a) => a.spec.type === 'dictation' && a.outcome === 'correct')!;
    const words = dict.spec.type === 'dictation' ? dict.spec.segments.filter((s) => s.itemId).map((s) => s.itemId) : [];
    expect(dict.evidence.map((e) => e.itemId).sort()).toEqual([...new Set(words)].sort());
    expect(dict.evidence.every((e) => e.skill === 'listen' && e.baseStrength === 0.5)).toBe(true);
    expect(both!.recap!.activities).toBeGreaterThan(0);
  });

  it('spends time on the input strand as well as study', async () => {
    const { clock, engine } = await setup();
    const knows = stageOneLearner(engine);
    const since = clock.now();
    await days(engine, clock, knows);
    const m = engine.strandMinutes(since);
    expect(m.input).toBeGreaterThan(0);
    expect(m.study).toBeGreaterThan(m.input);
  });

  it('after a study-heavy week, missed dictations do not take over the next session', async () => {
    const { clock, engine } = await setup();
    const knows = stageOneLearner(engine);
    await days(engine, clock, knows, 6);
    clock.advance(86_400_000);
    // Misses every dictation: each miss queues a practice dictation, and the week's strand balance favours input.
    let { sessionId, next } = await engine.startSession(20);
    const strands: string[] = [];
    while (!next.done && strands.length < 20) {
      const v = next.activity;
      strands.push(typeOf(v.spec).strand);
      const input = v.spec.type === 'dictation' ? ({ kind: 'dont_know', latencyMs: 6000 } as const) : answerFor(v, knows);
      if (input) await engine.recordInteraction(v.activityId, input);
      clock.advance(v.spec.type === 'dictation' ? 15_000 : 8_000);
      await engine.completeActivity(v.activityId);
      next = await engine.nextActivity(sessionId);
    }
    const input = strands.filter((s) => s === 'input').length;
    expect(input, 'some listening in the opening').toBeGreaterThan(0);
    expect(input, 'listening is not most of the opening').toBeLessThanOrEqual(12);
  });

  it('a sound missed again after teaching comes back on a later day', async () => {
    const { clock, engine } = await setup();
    // Never hears small っ, so it is missed, taught, and missed again.
    const base = stageOneLearner(engine);
    const knows = (id: string) => id !== 'sound:sokuon' && base(id);
    const sessions = await days(engine, clock, knows, 8);
    const daysWithSokuon = sessions.filter(({ seen }) =>
      seen.some((v) => v.spec.type !== 'introduce' && v.spec.itemId === 'sound:sokuon'),
    ).length;
    expect(daysWithSokuon).toBeGreaterThan(1);
  });

  it('counts statuses from sparse state the same as listing every row', async () => {
    const { clock, engine } = await setup();
    await days(engine, clock, stageOneLearner(engine), 4);
    const brute = { unseen: 0, introduced: 0, learning: 0, known: 0, maintained: 0, leech: 0 };
    for (const c of catalog.clusters()) for (const row of engine.clusterRows(c.id)) brute[row.status] += 1;
    expect(brute.learning + brute.known).toBeGreaterThan(0);
    expect(engine.getLearnerState().counts).toEqual(brute);
  });

  it('replays to identical state, including the new interaction kinds', async () => {
    const { clock, store, engine } = await setup();
    const knows = stageOneLearner(engine);
    await days(engine, clock, knows);
    const log = await store.load('me');
    expect(log.some((e) => e.kind === 'choice')).toBe(true);
    const replayed = derive(log, catalog, DEFAULT_CONFIG, await createScheduler(DEFAULT_CONFIG));
    expect([...replayed.states.entries()]).toEqual([...engine.learner.states.entries()]);
    expect(replayed.evidence).toEqual(engine.learner.evidence);
  });
});

describe('skips and partial dictations (regressions found in the browser)', () => {
  async function skipping(skip: (v: ActivityView) => boolean, knows: (id: string) => boolean) {
    const { clock, engine } = await setup();
    let { sessionId, next } = await engine.startSession(10);
    const attempts = new Map<string, number>();
    while (!next.done && [...attempts.values()].reduce((a, b) => a + b, 0) < 300) {
      const v = next.activity;
      if (v.spec.type !== 'introduce') attempts.set(v.spec.itemId, (attempts.get(v.spec.itemId) ?? 0) + 1);
      const input = skip(v) ? ({ kind: 'skip' } as const) : answerFor(v, (id) => knows(id) || engine.learner.lastExposure.has(id));
      if (input) await engine.recordInteraction(v.activityId, input);
      clock.advance(8_000);
      await engine.completeActivity(v.activityId);
      next = await engine.nextActivity(sessionId);
    }
    return attempts;
  }

  it('skipped placement probes do not keep coming back', async () => {
    const attempts = await skipping((v) => v.spec.type !== 'introduce', () => false);
    for (const [id, n] of attempts) expect(n, `${id} kept coming back after skips`).toBeLessThanOrEqual(2);
  });

  it('a skipped practice prompt after a miss does not keep coming back', async () => {
    // Knows basic hiragana only, so voiced kana (whose parts are known) are missed and practised.
    const knows = (id: string) => item(id).cluster === 'hiragana-basic';
    let skippedAfterMiss = 0;
    const attempts = await skipping((v) => {
      const skip = v.spec.type === 'retrieval' && v.spec.purpose === 'practice' && v.item.cluster === 'hiragana-voiced';
      if (skip) skippedAfterMiss++;
      return skip;
    }, knows);
    expect(skippedAfterMiss, 'some practice after a miss was skipped').toBeGreaterThan(0);
    for (const [id, n] of attempts) expect(n, `${id} kept coming back after skips`).toBeLessThanOrEqual(3);
  });

  it('a dictation counts the target word as heard when only another word was missed', async () => {
    const { clock, engine } = await setup();
    const knows = stageOneLearner(engine);
    let checked = false;
    for (let d = 0; d < 8 && !checked; d++) {
      if (d > 0) clock.advance(86_400_000);
      let { sessionId, next } = await engine.startSession(15);
      while (!next.done) {
        const v = next.activity;
        const spec = v.spec;
        const other = spec.type === 'dictation' ? spec.segments.find((s) => s.itemId && s.itemId !== spec.itemId) : undefined;
        if (spec.type === 'dictation' && other && !checked) {
          const text = spec.segments.map((s) => (s === other ? 'zz' : toRomaji(s.reading))).join('');
          await engine.recordInteraction(v.activityId, { kind: 'answer', text, latencyMs: 6000 });
          const a = engine.learner.activities.get(v.activityId)!;
          expect(a.outcome).toBe('correct');
          expect(a.evidence.find((e) => e.itemId === other.itemId)!.direction).toBe('negative');
          expect(a.evidence.find((e) => e.itemId === spec.itemId)!.direction).toBe('positive');
          checked = true;
        } else {
          const input = answerFor(v, knows);
          if (input) await engine.recordInteraction(v.activityId, input);
        }
        clock.advance(8_000);
        await engine.completeActivity(v.activityId);
        next = await engine.nextActivity(sessionId);
      }
      if (checked && next.done) expect(next.recap.missed).toContain(other0(engine));
    }
    expect(checked).toBe(true);
  });
});

/** The word missed in the checked dictation, read back from the log. */
function other0(engine: Engine): string {
  const a = [...engine.learner.activities.values()].find((x) => x.spec.type === 'dictation' && x.evidence.some((e) => e.direction === 'negative'))!;
  return a.evidence.find((e) => e.direction === 'negative')!.itemId;
}

describe('code-graded activities never reach the model', () => {
  it('runs sessions with every code-graded type and never calls or sees the Llm port', async () => {
    const llm: Llm = { call: vi.fn(async () => ({ output: null, stopReason: 'end_turn' })) };
    const code = activityTypes().filter((t) => t.grading === 'code');
    const contexts: object[] = [];
    const respond = code.filter((t) => t.respond).map((t) => {
      const original = t.respond!;
      t.respond = (e, a, ctx) => {
        contexts.push(ctx);
        return original(e, a, ctx);
      };
      return () => (t.respond = original);
    });
    const plan = code.map((t) => {
      const original = t.candidates;
      t.candidates = (ctx) => {
        contexts.push(ctx);
        return original(ctx);
      };
      return () => (t.candidates = original);
    });
    try {
      const { clock, engine } = await setup(llm);
      const knows = stageOneLearner(engine);
      const seen = (await days(engine, clock, knows)).flatMap((x) => x.seen);
      for (const t of code) expect(seen.some((v) => v.spec.type === t.id), t.id).toBe(true);
    } finally {
      [...respond, ...plan].forEach((undo) => undo());
    }
    expect(llm.call).not.toHaveBeenCalled();
    const reachesLlm = (obj: unknown, depth = 0): boolean => {
      if (!obj || typeof obj !== 'object' || depth > 2) return false;
      return Object.entries(obj).some(([k, v]) => k === 'llm' || v === llm || reachesLlm(v, depth + 1));
    };
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.some((c) => reachesLlm(c))).toBe(false);
  });
});

describe('closed-exercise cap', () => {
  /** A stand-in open, meaning-focused activity, since none exists yet. It always offers itself at a low score. */
  const open = {
    id: 'open_reading',
    strand: 'input',
    grading: 'model',
    closed: false,
    skills: ['read'],
    stages: [1, 2, 3, 4],
    expectedSeconds: () => 60,
    skillOf: () => null,
    candidates: (ctx: { needs: unknown[] }) => [
      { spec: { type: 'open_reading', itemId: 'vocab:本' }, score: 1, reason: 'open', order: ctx.needs.length },
    ],
  };

  async function closedShare(stageWords: [number, number, number]) {
    (REGISTRY as unknown as Record<string, unknown>).open_reading = open;
    try {
      const config = { ...DEFAULT_CONFIG, mix: { ...DEFAULT_CONFIG.mix, stageWords } };
      const clock = new FakeClock();
      const engine = await Engine.create({ catalog, store: new MemoryEventStore(), learnerId: 'me', clock, ids: seqIds(), utcOffsetMinutes: 0, config });
      const knows = stageOneLearner(engine);
      const { seen } = await runSession(engine, clock, knows, 10);
      const closed = seen.filter((v) => typeOf(v.spec).closed).length;
      return { stage: engine.stage(), share: closed / seen.length, opens: seen.filter((v) => v.spec.type === ('open_reading' as never)).length };
    } finally {
      delete (REGISTRY as unknown as Record<string, unknown>).open_reading;
    }
  }

  it('keeps closed exercises to a minority of a stage-2 session when an open activity is available', async () => {
    const r = await closedShare([0, 100_000, 200_000]);
    expect(r.stage).toBe(2);
    expect(r.share).toBeLessThanOrEqual(0.5);
    expect(r.opens).toBeGreaterThan(0);
  });

  it('does not cap stage 1', async () => {
    const r = await closedShare([300, 800, 1700]);
    expect(r.stage).toBe(1);
    expect(r.share).toBeGreaterThan(0.6);
  });
});

describe('starting a chosen activity (the demo page)', () => {
  it('grades it like a planned one and replays to the same state', async () => {
    const { store, engine } = await setup();
    const { sessionId } = await engine.startSession(10);
    const word = catalog.inCluster('vocab-band-1').find((i) => i.written !== i.reading)!;
    const view = await engine.startActivity(sessionId, { type: 'retrieval', itemId: word.id, cue: 'ja_to_en', purpose: 'practice', showFurigana: true });
    expect(view.item.id).toBe(word.id);
    const fb = await engine.recordInteraction(view.activityId, { kind: 'answer', text: word.gloss[0]!, latencyMs: 2000 });
    expect(fb.kind).toBe('correct');
    await engine.completeActivity(view.activityId);
    const replayed = await Engine.create({ catalog, store, learnerId: 'me', ids: seqIds(), utcOffsetMinutes: 0 });
    expect(replayed.learner.state(word.id, 'read')).toEqual(engine.learner.state(word.id, 'read'));
  });

  it('refuses an item the catalog does not have', async () => {
    const { engine } = await setup();
    const { sessionId } = await engine.startSession(10);
    await expect(
      engine.startActivity(sessionId, { type: 'introduce', itemId: 'vocab:nope' }),
    ).rejects.toThrow('Unknown item');
  });
});
