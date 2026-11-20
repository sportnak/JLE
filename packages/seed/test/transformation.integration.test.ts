import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Engine, MemoryEventStore, transformationSpec, type EngineConfig } from '@jle/engine';
import { buildCatalog } from '../src/index';

const catalog = buildCatalog();
const starter = catalog
  .clusters()
  .filter((c) => c.id.startsWith('vocab-band-'))
  .sort((a, b) => a.order - b.order)
  .flatMap((c) => catalog.inCluster(c.id));
const word = (w: string) => starter.find((i) => i.written === w)!;

describe('transformation', () => {
  it('accepts the form built from the written word and from its reading', () => {
    expect(transformationSpec(word('食べる'), 'polite past')!.expected).toEqual(['食べました', 'たべました']);
    expect(transformationSpec(word('来る'), 'negative form')!.expected).toEqual(['来ない', 'こない']);
    expect(transformationSpec(word('ある'), 'negative form')!.expected).toEqual(['ない']);
    expect(transformationSpec(word('行く'), 'て-form')!.expected).toEqual(['行って', 'いって']);
    expect(transformationSpec(word('静か'), 'polite past')!.expected).toEqual(['静かでした', 'しずかでした']);
    expect(transformationSpec(word('いい'), 'past form')!.expected).toEqual(['よかった']);
    expect(transformationSpec(word('本'), 'polite past')).toBeNull();
  });

  async function engineAt(stageWords: [number, number, number]) {
    const config: EngineConfig = { ...DEFAULT_CONFIG, mix: { ...DEFAULT_CONFIG.mix, stageWords } };
    let t = new Date('2026-11-01T09:00:00Z').getTime();
    let n = 0;
    const engine = await Engine.create({
      catalog,
      store: new MemoryEventStore(),
      learnerId: 'me',
      config,
      clock: { now: () => new Date(t) },
      ids: { next: () => `id-${++n}` },
      utcOffsetMinutes: 0,
    });
    for (const c of catalog.clusters().filter((k) => k.track === 'script')) for (const k of catalog.inCluster(c.id)) await engine.overrideItem(k.id);
    for (const w of starter.slice(0, 60)) await engine.overrideItem(w.id);
    return { engine, advance: (ms: number) => (t += ms) };
  }

  async function lesson(engine: Engine, advance: (ms: number) => void) {
    let { sessionId, next } = await engine.startSession(15);
    const types: string[] = [];
    for (let g = 0; !next.done && g < 300; g++) {
      const v = next.activity;
      types.push(v.spec.type);
      if (v.spec.type === 'transformation') await engine.recordInteraction(v.activityId, { kind: 'answer', text: v.spec.expected.at(-1)!, latencyMs: 4000 });
      else if (v.spec.type === 'retrieval') await engine.recordInteraction(v.activityId, { kind: 'answer', text: v.spec.cue === 'ja_to_en' ? v.item.gloss[0]! : v.item.reading, latencyMs: 2000 });
      else if (v.spec.type !== 'introduce') await engine.recordInteraction(v.activityId, { kind: 'dont_know', latencyMs: 2000 });
      advance(8000);
      await engine.completeActivity(v.activityId);
      next = await engine.nextActivity(sessionId);
    }
    return { sessionId, types };
  }

  it('is a stage-2 activity: never at stage 1, offered once stage 2 is reached', async () => {
    const one = await engineAt([10_000, 20_000, 30_000]);
    expect((await lesson(one.engine, one.advance)).types).not.toContain('transformation');
    // Stage counts Known words; the fixture's instant marks only reach Learning, so a threshold of 0 forces stage 2.
    const two = await engineAt([0, 20_000, 30_000]);
    // Same day, so the fixture's instant marks are not yet due for confirmation (which would fill the lesson).
    expect(two.engine.stage()).toBe(2);
    expect((await lesson(two.engine, two.advance)).types).toContain('transformation');
  });

  it('grades by the conjugator and lands lightly on the word, with no review scheduled', async () => {
    const { engine } = await engineAt([10_000, 20_000, 30_000]);
    const { sessionId } = await engine.startSession(10);
    const eat = word('食べる');
    const right = await engine.startActivity(sessionId, transformationSpec(eat, 'polite past')!);
    expect((await engine.recordInteraction(right.activityId, { kind: 'answer', text: 'たべました', latencyMs: 3000 })).kind).toBe('correct');
    const wrong = await engine.startActivity(sessionId, transformationSpec(eat, 'て-form')!);
    expect((await engine.recordInteraction(wrong.activityId, { kind: 'answer', text: 'たべって', latencyMs: 3000 })).kind).toBe('incorrect');
    const ev = (id: string) => engine.learner.activities.get(id)!.evidence.filter((e) => e.skill === 'write');
    expect(ev(right.activityId)).toEqual([expect.objectContaining({ direction: 'positive', baseStrength: DEFAULT_CONFIG.strengths.transformation, fsrsGrade: null })]);
    expect(ev(wrong.activityId)).toEqual([expect.objectContaining({ direction: 'negative', fsrsGrade: null })]);
  });
});
