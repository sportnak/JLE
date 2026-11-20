import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Engine, MemoryEventStore, type Catalog, type EngineConfig, type GrammarPoint } from '@jle/engine';
import { GRAMMAR } from '@jle/grammar';
import { buildCatalog } from '../src/index';

const approve = (p: GrammarPoint): GrammarPoint => ({ ...p, factSheet: { ...p.factSheet, status: 'approved', approvedBy: 'A Reviewer', approvedAt: '2026-11-21' } });
const wa = GRAMMAR.find((p) => p.id === 'wa-topic')!;

async function lesson(catalog: Catalog, answer: (spec: { options: string[]; answer: string }) => string) {
  const config: EngineConfig = { ...DEFAULT_CONFIG, mix: { ...DEFAULT_CONFIG.mix, stageWords: [0, 20_000, 30_000] } };
  let t = new Date('2026-11-01T09:00:00Z').getTime();
  let n = 0;
  const engine = await Engine.create({ catalog, store: new MemoryEventStore(), learnerId: 'me', config, clock: { now: () => new Date(t) }, ids: { next: () => `id-${++n}` }, utcOffsetMinutes: 0 });
  for (const c of catalog.clusters().filter((k) => k.track === 'script')) for (const k of catalog.inCluster(c.id)) await engine.overrideItem(k.id);
  let { sessionId, next } = await engine.startSession(15);
  for (let g = 0; !next.done && g < 300; g++) {
    const v = next.activity;
    if (v.spec.type === 'contrast') await engine.recordInteraction(v.activityId, { kind: 'choice', choice: answer(v.spec), latencyMs: 3000 });
    else if (v.spec.type === 'retrieval') await engine.recordInteraction(v.activityId, { kind: 'answer', text: v.spec.cue === 'ja_to_en' ? v.item.gloss[0]! : v.item.reading, latencyMs: 2000 });
    else if (v.spec.type !== 'introduce') await engine.recordInteraction(v.activityId, { kind: 'dont_know', latencyMs: 2000 });
    t += 8000;
    await engine.completeActivity(v.activityId);
    next = await engine.nextActivity(sessionId);
  }
  const acts = engine.learner.sessions.get(sessionId)!.activityIds.map((id) => engine.learner.activities.get(id)!);
  return { engine, acts };
}

describe('grammar and contrast choice', () => {
  it('draft points never reach the learner: no grammar items, no contrast', async () => {
    const catalog = buildCatalog();
    expect(GRAMMAR.every((p) => p.factSheet.status === 'draft')).toBe(true);
    expect(catalog.grammar()).toEqual([]);
    expect(catalog.inCluster('grammar')).toEqual([]);
    const { acts } = await lesson(catalog, (s) => s.answer);
    expect(acts.some((a) => a.spec.type === 'contrast')).toBe(false);
  });

  it('an approved point is practised by contrast choice and graded in code', async () => {
    const catalog = buildCatalog(GRAMMAR.map((p) => (p.id === 'wa-topic' ? approve(p) : p)));
    expect(catalog.grammar().map((p) => p.id)).toEqual(['wa-topic']);
    const { engine, acts } = await lesson(catalog, (s) => s.answer);
    const contrasts = acts.filter((a) => a.spec.type === 'contrast');
    expect(contrasts.length).toBeGreaterThan(0);
    const first = contrasts[0]!;
    expect(first.spec).toMatchObject({ pointId: 'wa-topic', version: wa.version, answer: 'は' });
    expect(first.outcome).toBe('correct');
    expect(first.evidence[0]).toMatchObject({ itemId: 'grammar:wa-topic', skill: 'read', direction: 'positive', baseStrength: DEFAULT_CONFIG.strengths.contrastChoice });
    // A grammar point is never shown as a word card or asked as a word.
    expect(acts.some((a) => a.spec.itemId === 'grammar:wa-topic' && a.spec.type !== 'contrast')).toBe(false);
    expect(engine.getLearnerState().placement.some((p) => p.cluster === 'grammar')).toBe(false);
  });

  it('a wrong choice is a miss on the point', async () => {
    const catalog = buildCatalog(GRAMMAR.map((p) => (p.id === 'wa-topic' ? approve(p) : p)));
    const { acts } = await lesson(catalog, (s) => s.options.find((o) => o !== s.answer)!);
    const first = acts.find((a) => a.spec.type === 'contrast')!;
    expect(first.outcome).toBe('wrong');
    expect(first.evidence[0]).toMatchObject({ itemId: 'grammar:wa-topic', direction: 'negative' });
  });

  it('a point waits for its prerequisites', async () => {
    const both = GRAMMAR.map((p) => (p.id === 'ga-subject' ? approve(p) : p.id === 'wa-topic' ? approve(p) : p));
    const { acts } = await lesson(buildCatalog(both), (s) => s.answer);
    const order = acts.filter((a) => a.spec.type === 'contrast').map((a) => (a.spec.type === 'contrast' ? a.spec.pointId : ''));
    expect(order[0]).toBe('wa-topic');
  });
});
