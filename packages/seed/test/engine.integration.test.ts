import { describe, expect, it } from 'vitest';
import { toRomaji } from 'wanakana';
import { derive, Engine, MemoryEventStore, DEFAULT_CONFIG, type ActivityView, type Clock, type Ids } from '@jle/engine';
import { createScheduler } from '../../engine/src/model';
import { buildCatalog } from '../src/index';

const catalog = buildCatalog();

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

/** A scripted learner: answers correctly for any item `knows` accepts, otherwise says "I don't know". */
function answerFor(view: ActivityView, knows: (itemId: string) => boolean) {
  if (view.spec.type !== 'retrieval') return null;
  if (!knows(view.item.id)) return { kind: 'dont_know' as const, latencyMs: 4000 };
  const text =
    view.spec.cue === 'ja_to_en' ? view.item.gloss[0]! : toRomaji(view.item.reading, { upcaseKatakana: false });
  return { kind: 'answer' as const, text, latencyMs: 2500 };
}

async function runSession(engine: Engine, clock: FakeClock, knows: (id: string) => boolean, minutes = 10) {
  let { sessionId, next } = await engine.startSession(minutes);
  const seen: ActivityView[] = [];
  let guard = 0;
  while (!next.done && guard++ < 500) {
    const view = next.activity;
    seen.push(view);
    const input = answerFor(view, knows);
    if (input) await engine.recordInteraction(view.activityId, input);
    clock.advance(15_000);
    await engine.completeActivity(view.activityId);
    next = await engine.nextActivity(sessionId);
  }
  return { seen, recap: next.done ? next.recap : null };
}

async function setup() {
  const clock = new FakeClock();
  const store = new MemoryEventStore();
  const engine = await Engine.create({ catalog, store, learnerId: 'me', clock, ids: seqIds(), utcOffsetMinutes: 0 });
  return { clock, store, engine };
}

describe('cold start', () => {
  it('places a true beginner as unknown and switches to teaching', async () => {
    const { clock, engine } = await setup();
    const { seen } = await runSession(engine, clock, () => false);
    const placement = Object.fromEntries(engine.getLearnerState().placement.map((p) => [p.cluster, p.placement]));
    expect(placement['hiragana-basic']).toBe('unknown');
    expect(placement['katakana-yoon']).toBe('unknown');
    expect(seen.some((v) => v.spec.type === 'introduce')).toBe(true);
    const introduced = seen.findIndex((v) => v.spec.type === 'introduce');
    expect(seen[introduced + 1]?.spec).toMatchObject({ type: 'retrieval', itemId: seen[introduced]!.item.id });
  });

  it('places someone who knows all kana and the first 60 words', async () => {
    const { clock, engine } = await setup();
    const knows = (id: string) => {
      const item = catalog.item(id)!;
      return item.type === 'script' || (item.type === 'vocab' && item.order < 1000 + 60);
    };
    await runSession(engine, clock, knows, 20);
    const placement = Object.fromEntries(engine.getLearnerState().placement.map((p) => [p.cluster, p.placement]));
    for (const c of ['hiragana-basic', 'hiragana-voiced', 'hiragana-yoon', 'katakana-basic', 'katakana-voiced', 'katakana-yoon']) {
      expect(placement[c], c).toBe('known');
    }
    expect(placement['vocab-band-1']).toBe('known');
    expect(placement['vocab-band-3']).toBe('known');
    expect(placement['vocab-band-4']).toBe('unknown');
    expect(placement['vocab-band-7']).toBe('unknown');
  });
});

describe('advancement over days', () => {
  it('makes an item Known only after a spaced review on another day', async () => {
    const { clock, engine } = await setup();
    await runSession(engine, clock, () => true, 15);
    const known1 = engine.getLearnerState().counts.known;
    clock.advance(6 * 86_400_000);
    await runSession(engine, clock, () => true, 15);
    const known2 = engine.getLearnerState().counts.known;
    expect(known1).toBe(0);
    expect(known2).toBeGreaterThan(0);
  });
});

describe('replay', () => {
  it('rebuilds identical state from the event log', async () => {
    const { clock, store, engine } = await setup();
    const knows = (id: string) => id.charCodeAt(id.length - 1) % 3 !== 0;
    await runSession(engine, clock, knows, 10);
    clock.advance(2 * 86_400_000);
    await runSession(engine, clock, knows, 10);

    const replayed = derive(await store.load('me'), catalog, DEFAULT_CONFIG, await createScheduler(DEFAULT_CONFIG));
    expect([...replayed.states.entries()]).toEqual([...engine.learner.states.entries()]);
    expect(replayed.evidence).toEqual(engine.learner.evidence);
  });
});

describe('dispute and flag', () => {
  it('a dispute turns the wrong answer into a correct one', async () => {
    const { engine } = await setup();
    const { next } = await engine.startSession(10);
    if (next.done) throw new Error('expected an activity');
    const view = next.activity;
    await engine.recordInteraction(view.activityId, { kind: 'answer', text: 'zzz', latencyMs: 3000 });
    expect(engine.learner.activities.get(view.activityId)!.outcome).toBe('wrong');
    await engine.recordInteraction(view.activityId, { kind: 'dispute' });
    expect(engine.learner.activities.get(view.activityId)!.outcome).toBe('correct');
  });

  it('a flag discards the evidence the activity produced', async () => {
    const { engine } = await setup();
    const { next } = await engine.startSession(10);
    if (next.done) throw new Error('expected an activity');
    const view = next.activity;
    await engine.recordInteraction(view.activityId, { kind: 'dont_know', latencyMs: 3000 });
    expect(engine.learner.activities.get(view.activityId)!.evidence.length).toBeGreaterThan(0);
    await engine.flagContent(view.activityId, 'wrong reading');
    expect(engine.learner.activities.get(view.activityId)!.evidence).toEqual([]);
  });
});

describe('"I know this"', () => {
  it('counts as strong evidence and schedules a confirming probe', async () => {
    const { clock, engine } = await setup();
    await engine.overrideItem(catalog.resolve('vocab:食べる'));
    const s = engine.learner.state(catalog.resolve('vocab:食べる'), 'write');
    expect(s.pKnown).toBeGreaterThan(0.6);
    expect(s.status).not.toBe('known');
    clock.advance(86_400_000 + 1000);
    const started = await engine.startSession(10);
    const specs = [];
    let n = started.next;
    while (!n.done && specs.length < 60) {
      specs.push(n.activity.spec);
      await engine.recordInteraction(n.activity.activityId, { kind: 'dont_know', latencyMs: 3000 });
      await engine.completeActivity(n.activity.activityId);
      clock.advance(5_000);
      n = await engine.nextActivity(started.sessionId);
    }
    expect(specs).toContainEqual(expect.objectContaining({ itemId: catalog.resolve('vocab:食べる'), purpose: 'confirm' }));
  });
});

describe('learner-state views', () => {
  it('reports Known items added since a date by replaying the log', async () => {
    const { clock, engine } = await setup();
    const weekStart = clock.now();
    await runSession(engine, clock, () => true, 15);
    clock.advance(6 * 86_400_000);
    await runSession(engine, clock, () => true, 15);
    const added = engine.knownAddedSince(weekStart);
    expect(Object.values(added).reduce((a, b) => a + (b ?? 0), 0)).toBeGreaterThan(0);
    expect(engine.knownAddedSince(clock.now())).toEqual({});
  });

  it('previews the mix, counts study minutes and lists what comes next', async () => {
    const { clock, engine } = await setup();
    expect(engine.previewMix().length).toBeGreaterThan(0);
    const since = clock.now();
    await runSession(engine, clock, () => false, 5);
    expect(engine.strandMinutes(since).study).toBeGreaterThan(0);
    expect(engine.strandMinutes(since).input).toBe(0);
    expect(engine.comingUp(3).length).toBe(3);
  });
});

describe('no loops (regression: a session that re-asked basics and dropped misses)', () => {
  it('rests correct items and brings misses back', async () => {
    const { clock, engine } = await setup();
    const missing = new Set(['kana:ぺ', 'kana:ぽ']);
    // Knows basic and voiced hiragana except ぺ and ぽ, and the first five words; learns anything once shown.
    const knowsAtStart = (id: string) => {
      const item = catalog.item(id)!;
      if (missing.has(id)) return false;
      return item.type === 'script' ? item.cluster.startsWith('hiragana') : item.order < 1000 + 5;
    };
    const knows = (id: string) => knowsAtStart(id) || engine.learner.lastExposure.has(id);
    const { seen } = await runSession(engine, clock, knows, 10);
    const acts = seen.map((v) => engine.learner.activities.get(v.activityId)!);

    const byItem = new Map<string, typeof acts>();
    for (const a of acts) byItem.set(a.spec.itemId, [...(byItem.get(a.spec.itemId) ?? []), a]);

    for (const [itemId, list] of byItem) {
      const misses = list.filter((a) => a.outcome === 'wrong' || a.outcome === 'dont_know').length;
      const retrievals = list.filter((a) => a.spec.type === 'retrieval').length;
      if (misses === 0) expect(retrievals, `${itemId} re-asked without a miss`).toBeLessThanOrEqual(2);
      else expect(retrievals, `${itemId} looped`).toBeLessThanOrEqual(2 + misses + 1);
    }

    for (const [itemId, list] of byItem) {
      const firstMiss = list.findIndex((a) => a.outcome === 'wrong' || a.outcome === 'dont_know');
      if (firstMiss < 0) continue;
      const item = catalog.item(itemId)!;
      const prereqsKnown = catalog.edgesInto(itemId).every((e) => knowsAtStart(e.from));
      if (!prereqsKnown || item.type !== 'script') continue;
      expect(list.length, `${itemId} was missed and never came back`).toBeGreaterThan(firstMiss + 1);
    }

    expect(new Set(acts.map((a) => a.spec.itemId)).size, 'covered new ground').toBeGreaterThanOrEqual(15);

    // Interleaving: outside placement, no long runs of one item type (an introduction and its
    // immediate use may push a run to four). Placement prompts don't count toward a run, but one of
    // another type still breaks it, as it does on screen.
    let run = 0;
    let prev = '';
    for (const a of acts) {
      const type = catalog.item(a.spec.itemId)!.type;
      if (a.spec.type !== 'introduce' && a.spec.purpose === 'placement') {
        if (type !== prev) run = 0;
        prev = type;
        continue;
      }
      run = type === prev ? run + 1 : 1;
      prev = type;
      expect(run, `run of ${type} at ${a.spec.itemId}`).toBeLessThanOrEqual(4);
    }
  });
});

describe('session clock', () => {
  async function timedSession(secondsPerPrompt: number) {
    const { clock, engine } = await setup();
    const started = clock.now().getTime();
    let { sessionId, next } = await engine.startSession(5);
    let prompts = 0;
    while (!next.done && prompts < 500) {
      const v = next.activity;
      const input = answerFor(v, () => true);
      if (input) await engine.recordInteraction(v.activityId, input);
      clock.advance(secondsPerPrompt * 1000);
      await engine.completeActivity(v.activityId);
      prompts++;
      next = await engine.nextActivity(sessionId);
    }
    return { engine, sessionId, realMinutes: (clock.now().getTime() - started) / 60_000 };
  }

  it('moves forward by the time saved when prompts go faster than expected', async () => {
    const { engine, sessionId, realMinutes } = await timedSession(2);
    const c = engine.sessionClock(sessionId);
    expect(c.creditMs).toBeGreaterThan(0);
    expect(c.elapsedMs).toBe(5 * 60_000);
    expect(realMinutes).toBeLessThan(4);
  });

  it('gives no credit when prompts take longer than expected', async () => {
    const { engine, sessionId, realMinutes } = await timedSession(30);
    expect(engine.sessionClock(sessionId).creditMs).toBe(0);
    expect(realMinutes).toBeGreaterThanOrEqual(5);
  });

  it('is derived from the log, so replay gives the same clock', async () => {
    const { engine, sessionId } = await timedSession(3);
    const before = engine.sessionClock(sessionId);
    engine.rebuild();
    expect(engine.sessionClock(sessionId)).toEqual(before);
  });
});

describe('placement over the dictionary', () => {
  it('probes far down the frequency list but teaches only near the frontier', async () => {
    const { clock, engine } = await setup();
    const knows = (id: string) => {
      const item = catalog.item(id)!;
      return item.type === 'script' ? item.cluster.startsWith('hiragana') : item.type === 'vocab' && item.order < 1000 + 40;
    };
    const { seen } = await runSession(engine, clock, knows, 15);
    const band = (id: string) => Number(/^words-(\d+)$/.exec(catalog.item(id)!.cluster)?.[1] ?? 0);
    const probedFar = seen.filter((v) => v.spec.type === 'retrieval' && v.spec.purpose === 'placement' && band(v.item.id) > 2);
    expect(probedFar.length, 'placement reached the frequency bands').toBeGreaterThan(0);
    const taughtFar = seen.filter((v) => v.spec.type === 'introduce' && band(v.item.id) > 2);
    expect(taughtFar.map((v) => v.item.written)).toEqual([]);
  });
});
