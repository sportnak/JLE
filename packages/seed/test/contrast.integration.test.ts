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

import { MemoryExplanationStore, matchGrammar, type ContentToken, type Llm, type StoredContent } from '@jle/engine';

/** Tokens with what the matcher reads: surface, dictionary form, part of speech, conjugation form. */
function toks(parts: [surface: string, lemma: string, pos: string, form?: string][]): ContentToken[] {
  let at = 0;
  return parts.map(([surface, lemma, pos, form]) => {
    const t: ContentToken = { surface, reading: surface, begin: at, end: at + [...surface].length, lemma, pos, ...(form ? { form } : {}) };
    at = t.end;
    return t;
  });
}

describe('finding grammar in passages', () => {
  const point = (id: string) => GRAMMAR.find((p) => p.id === id)!;

  it('matches single steps, alternatives and sequences', () => {
    // 私は本を読んでいます。
    const t = toks([
      ['私', '私', '代名詞'],
      ['は', 'は', '助詞'],
      ['本', '本', '名詞'],
      ['を', 'を', '助詞'],
      ['読ん', '読む', '動詞', '連用形-撥音便'],
      ['で', 'て', '助詞'],
      ['い', 'いる', '動詞', '連用形-一般'],
      ['ます', 'ます', '助動詞'],
      ['。', '。', '補助記号'],
    ]);
    const found = matchGrammar(t, [point('wa-topic'), point('wo-object'), point('te-iru'), point('te-form'), point('aru-iru'), point('ga-subject')]);
    const by = (id: string) => found.filter((s) => s.pointId === id).map((s) => [s.begin, s.end]);
    expect(by('wa-topic')).toEqual([[1, 2]]);
    expect(by('wo-object')).toEqual([[3, 4]]);
    expect(by('te-form')).toEqual([[4, 7]]);
    expect(by('te-iru')).toEqual([[4, 8]]);
    expect(by('aru-iru')).toEqual([[7, 8]]);
    expect(by('ga-subject')).toEqual([]);
  });

  it('reading a passage credits an approved point already met, and nothing for drafts', async () => {
    const catalog = buildCatalog(GRAMMAR.map((p) => (p.id === 'wa-topic' ? approve(p) : p)));
    const engine = await Engine.create({ catalog, store: new MemoryEventStore(), learnerId: 'me' });
    await engine.overrideItem('grammar:wa-topic');
    const tokens = toks([['これ', 'これ', '代名詞'], ['は', 'は', '助詞'], ['本', '本', '名詞'], ['を', 'を', '助詞'], ['。', '。', '補助記号']]);
    const word = catalog.byWritten('本')[0]!;
    tokens[2]!.itemId = word.id;
    const content: StoredContent = { id: 'c', learnerId: 'me', createdAt: '2026-11-21T00:00:00Z', source: 'learner', promptVersion: 't', model: 'none', title: 't', text: 'これは本を。', translation: '', tokens, items: [word], targets: [], coverage: 1 };
    engine.adoptContent(content);
    const { sessionId } = await engine.startSession(5);
    const v = await engine.startActivity(sessionId, { type: 'reading', itemId: word.id, purpose: 'practice', contentId: 'c', chars: 6 });
    await engine.finishReading(v.activityId, 5000);
    const ev = engine.learner.activities.get(v.activityId)!.evidence;
    expect(ev.filter((e) => e.itemId === 'grammar:wa-topic')).toEqual([expect.objectContaining({ direction: 'positive', baseStrength: DEFAULT_CONFIG.strengths.readPast })]);
    // を is a draft: no item, no evidence.
    expect(ev.some((e) => e.itemId === 'grammar:wo-object')).toBe(false);
    expect(engine.learner.meetings.get('grammar:wa-topic')).toBe(1);
  });
});

describe('explaining a mistake', () => {
  it('is written once from the approved fact sheet, then read back without the model', async () => {
    const catalog = buildCatalog(GRAMMAR.map((p) => (p.id === 'wa-topic' ? approve(p) : p)));
    const calls: unknown[] = [];
    const llm: Llm = {
      call: async (route, request) => {
        calls.push([route, request]);
        return { output: { explanation: 'は marks the topic here.' }, stopReason: 'end_turn', model: 'claude-opus-5-5', callId: 'x' };
      },
    };
    const explanations = new MemoryExplanationStore();
    const engine = await Engine.create({ catalog, store: new MemoryEventStore(), learnerId: 'me', llm, explanations });
    const { sessionId } = await engine.startSession(5);
    const point = catalog.grammar()[0]!;
    const spec = { type: 'contrast' as const, itemId: 'grammar:wa-topic', purpose: 'practice' as const, pointId: 'wa-topic', version: point.version, example: 0, sentence: point.contrasts[0]!.sentence, translation: point.contrasts[0]!.translation, options: ['は', 'が'] as [string, string], answer: 'は' };
    const right = await engine.startActivity(sessionId, spec);
    await engine.recordInteraction(right.activityId, { kind: 'choice', choice: 'は', latencyMs: 1000 });
    await expect(engine.explain(right.activityId)).rejects.toThrow('Only a wrong contrast choice');
    for (let k = 0; k < 2; k++) {
      const wrong = await engine.startActivity(sessionId, spec);
      await engine.recordInteraction(wrong.activityId, { kind: 'choice', choice: 'が', latencyMs: 1000 });
      expect(await engine.explain(wrong.activityId)).toBe('は marks the topic here.');
    }
    expect(calls).toHaveLength(1);
    const [route, request] = calls[0] as [string, { user: string; system: string }];
    expect(route).toBe('explain');
    expect(request.user).toContain(point.factSheet.body);
    expect([...explanations.entries.keys()]).toEqual([`wa-topic:v${point.version}:0:が`]);
  });
});
