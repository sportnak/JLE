import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  Engine,
  MemoryEventStore,
  MemoryGradeStore,
  WRITING_TASKS,
  mapGrade,
  singleErrorSentence,
  type ActivitySpec,
  type Dictionary,
  type EngineConfig,
  type GrammarPoint,
  type Ids,
  type Llm,
  type LlmRequest,
  type Token,
  type Tokenizer,
} from '@jle/engine';
import { GRAMMAR } from '@jle/grammar';
import { buildCatalog } from '../src/index';

const approve = (p: GrammarPoint): GrammarPoint => ({ ...p, factSheet: { ...p.factSheet, status: 'approved', approvedBy: 'A Reviewer', approvedAt: '2026-11-21' } });
// を is approved; と / や and 〜ている stay drafts.
const catalog = buildCatalog(GRAMMAR.map((p) => (p.id === 'wo-object' ? approve(p) : p)));
const starter = catalog
  .clusters()
  .filter((c) => c.id.startsWith('vocab-band-'))
  .sort((a, b) => a.order - b.order)
  .flatMap((c) => catalog.inCluster(c.id));
const word = (written: string) => starter.find((i) => i.written === written)!;
const id = (written: string) => word(written).id;

function tokens(parts: [surface: string, lemma: string, reading: string, pos0: string][]): Token[] {
  let at = 0;
  return parts.map(([surface, lemma, reading, pos0]) => {
    const t: Token = { surface, dictionaryForm: lemma, normalizedForm: lemma, reading, dictionaryReading: reading, pos: [pos0, '*', '*', '*', '*', '*'], begin: at, end: at + [...surface].length, oov: false };
    at = t.end;
    return t;
  });
}

// Code points: 私0 は1 毎日2-3 コーヒー4-7 が8 飲むました9-13 。14 友達15-16 と17 本18 を19 読みます20-23 。24
const S1 = '私は毎日コーヒーが飲むました。';
const S2 = '友達と本を読みます。';
const ANSWER = S1 + S2;
const TOKENS: Record<string, Token[]> = {
  [S1]: tokens([
    ['私', '私', 'わたし', '代名詞'],
    ['は', 'は', 'は', '助詞'],
    ['毎日', '毎日', 'まいにち', '名詞'],
    ['コーヒー', 'コーヒー', 'こーひー', '名詞'],
    ['が', 'が', 'が', '助詞'],
    ['飲む', '飲む', 'のむ', '動詞'],
    ['まし', 'ます', 'まし', '助動詞'],
    ['た', 'た', 'た', '助動詞'],
    ['。', '。', '', '補助記号'],
  ]),
  [S2]: tokens([
    ['友達', '友達', 'ともだち', '名詞'],
    ['と', 'と', 'と', '助詞'],
    ['本', '本', 'ほん', '名詞'],
    ['を', 'を', 'を', '助詞'],
    ['読み', '読む', 'よみ', '動詞'],
    ['ます', 'ます', 'ます', '助動詞'],
    ['。', '。', '', '補助記号'],
  ]),
};

const tokenizer: Tokenizer = {
  analyze: async (text) => {
    const out: Token[] = [];
    let rest = text;
    while (rest) {
      const known = Object.keys(TOKENS).find((k) => rest.startsWith(k));
      if (!known) throw new Error(`no fixture tokens for ${rest}`);
      const at = [...text].length - [...rest].length;
      out.push(...TOKENS[known]!.map((t) => ({ ...t, begin: t.begin + at, end: t.end + at })));
      rest = rest.slice(known.length);
    }
    return out;
  },
};

const dictionary: Dictionary = {
  lookup: async (keys) =>
    keys.map(({ lemma }) => {
      const item = starter.find((i) => i.written === lemma);
      return item ? { id: Number(item.id.slice('jmdict:'.length)), written: item.written, reading: item.reading, freqRank: item.tags.freq ?? null, pos: [], gloss: item.gloss } : null;
    }),
};

/** A recorded grade for ANSWER: two errors in the first sentence, and every kind of finding the mapper must handle. */
const RECORDED = {
  findings: [
    { quote: 'が', lemma: null, grammarPoint: 'wo-object', errorType: 'particle', correction: 'を', explanation: '飲む takes its object with を.', confidence: 'high' },
    { quote: '飲むました', lemma: '飲む', grammarPoint: null, errorType: 'conjugation', correction: '飲みました', explanation: 'ました joins the stem 飲み.', confidence: 'high' },
    { quote: '友達', lemma: '友達', grammarPoint: null, errorType: 'word_choice', correction: '友人', explanation: 'A fixture.', confidence: 'medium' },
    // Draft grammar point: dropped to null; no lemma, so it cannot be mapped.
    { quote: 'と', lemma: null, grammarPoint: 'to-ya-and', errorType: 'particle', correction: 'とは', explanation: 'A fixture.', confidence: 'medium' },
    // Low confidence: mapped, but no evidence.
    { quote: '読みます', lemma: '読む', grammarPoint: 'te-iru', errorType: 'conjugation', correction: '読んでいます', explanation: 'Maybe ongoing.', confidence: 'low' },
    // Not in the answer: null span, mapped through the catalog by its lemma.
    { quote: 'パンを', lemma: 'パン', grammarPoint: null, errorType: 'missing_word', correction: 'パンを', explanation: 'A fixture.', confidence: 'medium' },
    // Not in the answer and an unknown word: kept, unmapped. An unknown error type becomes other; bad confidence low.
    { quote: 'ほげ', lemma: 'ほげ', grammarPoint: 'made-up', errorType: 'typo', correction: 'x', explanation: '', confidence: 'certain' },
    { quote: '', lemma: '本', grammarPoint: null, errorType: 'other', correction: '', explanation: 'no quote', confidence: 'high' },
  ],
  corrected: '私は毎日コーヒーを飲みました。友人と本を読みます。',
  targetsUsed: ['コーヒー', '飲む', '本', 'ラーメン'],
  comment: 'Good effort!',
};
const CLEAN = { findings: [], corrected: ANSWER, targetsUsed: ['コーヒー'], comment: 'Well done.' };

function fakeLlm(outputs: unknown[]) {
  const requests: LlmRequest[] = [];
  let i = 0;
  const llm: Llm = {
    call: vi.fn(async (route, request: LlmRequest) => {
      if (route !== 'grade') throw new Error(`unexpected route ${route}`);
      requests.push(request);
      const out = outputs[Math.min(i++, outputs.length - 1)];
      if (out instanceof Error) throw out;
      return { output: out, stopReason: 'end_turn', model: 'claude-opus-5-5', callId: `call-${i}` };
    }),
  };
  return { llm, requests };
}

const seqIds = (): Ids => {
  let n = 0;
  return { next: () => `id-${++n}` };
};

const STAGE3: [number, number, number] = [0, 0, 100_000];
const configAt = (stageWords: [number, number, number]): EngineConfig => ({ ...DEFAULT_CONFIG, mix: { ...DEFAULT_CONFIG.mix, stageWords } });
const KNOWN = ['私', '毎日', 'コーヒー', '飲む', '友達', '本', '読む', 'パン', '食べる'];

async function learner(outputs: unknown[], opts: { stageWords?: [number, number, number]; model?: boolean } = {}) {
  let t = new Date('2026-11-01T09:00:00Z').getTime();
  const clock = { now: () => new Date(t), advance: (ms: number) => (t += ms) };
  const store = new MemoryEventStore();
  const grades = new MemoryGradeStore();
  const { llm, requests } = fakeLlm(outputs);
  const make = (l: Llm | null) =>
    Engine.create({
      catalog,
      store,
      grades,
      learnerId: 'me',
      clock,
      ids: seqIds(),
      utcOffsetMinutes: 0,
      config: configAt(opts.stageWords ?? STAGE3),
      ...(l ? { llm: l } : {}),
      tokenizer,
      dictionary,
    });
  const engine = await make(opts.model === false ? null : llm);
  for (const c of catalog.clusters().filter((k) => k.track === 'script')) for (const k of catalog.inCluster(c.id)) await engine.overrideItem(k.id);
  for (const w of [...starter.slice(0, 30), ...KNOWN.map(word)]) await engine.overrideItem(w.id);
  return { engine, clock, store, grades, llm, requests, make };
}

const SPEC: Extract<ActivitySpec, { type: 'writing' }> = {
  type: 'writing',
  itemId: id('コーヒー'),
  purpose: 'practice',
  task: WRITING_TASKS[0]!,
  targets: [id('コーヒー'), id('飲む'), id('本')],
  sentences: 2,
};

async function writeOnce(engine: Engine, spec = SPEC) {
  const { sessionId } = await engine.startSession(10);
  const v = await engine.startActivity(sessionId, spec);
  return { sessionId, activityId: v.activityId };
}

/** Runs a session to its end; writing gets ANSWER, retrieval is answered right, anything else is not known. */
async function session(engine: Engine, clock: { advance(ms: number): void }) {
  let { sessionId, next } = await engine.startSession(15);
  const types: string[] = [];
  for (let g = 0; !next.done && g < 300; g++) {
    const v = next.activity;
    types.push(v.spec.type);
    if (v.spec.type === 'writing') await engine.submitWriting(v.activityId, ANSWER, 60_000);
    else if (v.spec.type === 'retrieval') await engine.recordInteraction(v.activityId, { kind: 'answer', text: v.spec.cue === 'ja_to_en' ? v.item.gloss[0]! : v.item.reading, latencyMs: 2000 });
    else if (v.spec.type !== 'introduce') await engine.recordInteraction(v.activityId, { kind: 'dont_know', latencyMs: 2000 });
    clock.advance(8000);
    await engine.completeActivity(v.activityId);
    next = await engine.nextActivity(sessionId);
  }
  return { sessionId, types };
}

describe('free writing: planning', () => {
  it('is offered from stage 3, once a session, with words taught for production', async () => {
    const { engine, clock, llm } = await learner([CLEAN]);
    expect(engine.stage()).toBe(3);
    expect(engine.canWrite).toBe(true);
    const first = await session(engine, clock);
    expect(first.types.filter((t) => t === 'writing')).toHaveLength(1);
    const a = [...engine.learner.activities.values()].find((x) => x.spec.type === 'writing')!;
    if (a.spec.type !== 'writing') throw new Error('not writing');
    expect(a.spec.targets.length).toBeGreaterThanOrEqual(2);
    expect(a.spec.targets.length).toBeLessThanOrEqual(3);
    expect(a.spec.itemId).toBe(a.spec.targets[0]);
    expect(WRITING_TASKS).toContain(a.spec.task);
    expect([2, 3]).toContain(a.spec.sentences);
    for (const t of a.spec.targets) {
      const s = engine.learner.state(t, 'write');
      expect(s.card).not.toBeNull();
    }
    expect(llm.call).toHaveBeenCalledTimes(1);
    clock.advance(86_400_000);
    const second = await session(engine, clock);
    expect(second.types.filter((t) => t === 'writing')).toHaveLength(1);
  });

  it('is not offered before stage 3', async () => {
    const { engine, clock, llm } = await learner([CLEAN], { stageWords: [0, 100_000, 200_000] });
    expect(engine.stage()).toBe(2);
    const { types } = await session(engine, clock);
    expect(types).not.toContain('writing');
    expect(llm.call).not.toHaveBeenCalled();
  });

  it('is not offered when there is no model to grade it', async () => {
    const { engine, clock } = await learner([CLEAN], { model: false });
    expect(engine.canWrite).toBe(false);
    const { types } = await session(engine, clock);
    expect(types).not.toContain('writing');
  });

  it('a stage-4 task asks for three to five sentences', async () => {
    const { engine, clock } = await learner([CLEAN], { stageWords: [0, 0, 0] });
    expect(engine.stage()).toBe(4);
    await session(engine, clock);
    const a = [...engine.learner.activities.values()].find((x) => x.spec.type === 'writing');
    if (a?.spec.type !== 'writing') throw new Error('no writing at stage 4');
    expect(a.spec.sentences).toBeGreaterThanOrEqual(3);
    expect(a.spec.sentences).toBeLessThanOrEqual(5);
  });
});

describe('free writing: grading', () => {
  it('sends the task, targets, approved grammar ids and the answer, and never the known-word list', async () => {
    const { engine, requests } = await learner([RECORDED]);
    const { activityId } = await writeOnce(engine);
    await engine.submitWriting(activityId, ANSWER);
    expect(requests).toHaveLength(1);
    const r = requests[0]!;
    expect(r.promptVersion).toBe('grade-1');
    expect(r.effort).toBe('medium');
    expect(r.maxTokens).toBe(8000);
    expect(r.user).toContain(WRITING_TASKS[0]);
    expect(r.user).toContain(ANSWER);
    // The approved grammar list is in the cached system text, not the per-call user message.
    expect(r.system).toContain('wo-object');
    expect(r.user).not.toContain('wo-object');
    expect(r.system).toContain('quote the word just before the gap');
    // Drafts never reach the model.
    for (const p of GRAMMAR.filter((g) => g.id !== 'wo-object')) {
      expect(r.user).not.toContain(p.id);
      expect(r.system).not.toContain(p.id);
    }
    // Words the learner knows that are neither targets nor in the answer never appear.
    for (const w of starter.slice(0, 30)) {
      if (w.written.length < 2 || ANSWER.includes(w.written) || SPEC.targets.includes(w.id)) continue;
      expect(r.user.includes(w.written), w.written).toBe(false);
      expect(r.system.includes(w.written), w.written).toBe(false);
    }
  });

  it('maps findings by grammar point and by lemma, keeps unmappable ones without an item', async () => {
    const { engine } = await learner([RECORDED]);
    const { activityId } = await writeOnce(engine);
    const g = await engine.submitWriting(activityId, ANSWER);
    expect(engine.grade(g.id)).toEqual(g);
    expect(g).toMatchObject({ activityId, answer: ANSWER, promptVersion: 'grade-1', model: 'claude-opus-5-5', comment: 'Good effort!', corrected: RECORDED.corrected });
    const by = (quote: string) => g.findings.find((f) => f.quote === quote)!;
    expect(g.findings).toHaveLength(7);
    expect(by('が')).toMatchObject({ itemId: 'grammar:wo-object', begin: 8, end: 9 });
    expect(by('飲むました')).toMatchObject({ itemId: id('飲む'), begin: 9, end: 14 });
    expect(by('友達')).toMatchObject({ itemId: id('友達'), begin: 15, end: 17 });
    expect(by('と')).toMatchObject({ grammarPoint: null, begin: 17, end: 18 });
    expect(by('と').itemId).toBeUndefined();
    expect(by('読みます')).toMatchObject({ itemId: id('読む'), grammarPoint: null, confidence: 'low' });
    expect(by('パンを')).toMatchObject({ itemId: id('パン'), begin: null, end: null });
    expect(by('パンを').singleErrorSentence).toBeUndefined();
    expect(by('ほげ')).toMatchObject({ errorType: 'other', confidence: 'low', grammarPoint: null, begin: null, end: null });
    expect(by('ほげ').itemId).toBeUndefined();
    expect(g.targetsUsed).toEqual([id('コーヒー'), id('飲む'), id('本')]);
    expect(new Set(g.usedItems)).toEqual(new Set(['私', '毎日', 'コーヒー', '飲む', '友達', '本', '読む'].map(id)));
  });

  it('a single-error sentence keeps exactly one error, with two errors in one sentence', async () => {
    const { engine } = await learner([RECORDED]);
    const { activityId } = await writeOnce(engine);
    const g = await engine.submitWriting(activityId, ANSWER);
    const by = (quote: string) => g.findings.find((f) => f.quote === quote)!;
    expect(by('が').singleErrorSentence).toBe('私は毎日コーヒーが飲みました。');
    expect(by('飲むました').singleErrorSentence).toBe('私は毎日コーヒーを飲むました。');
    expect(by('友達').singleErrorSentence).toBe('友達とは本を読んでいます。');
    // Overlapping corrections are skipped (the rightmost wins) rather than mangled.
    expect(singleErrorSentence('あいう。', { begin: 0, end: 1 }, [{ begin: 0, end: 1, correction: 'x' }, { begin: 1, end: 3, correction: 'yz' }, { begin: 2, end: 3, correction: 'q' }])).toBe('あいq。');
  });

  it('gives evidence by confidence, credits targets used, and sets the outcome', async () => {
    const { engine } = await learner([RECORDED]);
    const { activityId } = await writeOnce(engine);
    await engine.submitWriting(activityId, ANSWER);
    const a = engine.learner.activities.get(activityId)!;
    const s = DEFAULT_CONFIG.strengths;
    const direct = a.evidence.filter((e) => e.skill === 'write' || e.itemId.startsWith('grammar:'));
    const ev = (written: string) => direct.filter((e) => e.itemId === (written.startsWith('grammar:') ? written : id(written)));
    expect(ev('grammar:wo-object')).toEqual([expect.objectContaining({ skill: 'read', direction: 'negative', baseStrength: s.writingErrorHigh, fsrsGrade: null })]);
    expect(ev('飲む')).toEqual([expect.objectContaining({ direction: 'negative', baseStrength: s.writingErrorHigh, fsrsGrade: 'again' })]);
    expect(ev('友達')).toEqual([expect.objectContaining({ direction: 'negative', baseStrength: s.writingErrorMedium, fsrsGrade: null })]);
    expect(ev('パン')).toEqual([expect.objectContaining({ direction: 'negative', baseStrength: s.writingErrorMedium })]);
    expect(ev('コーヒー')).toEqual([expect.objectContaining({ direction: 'positive', baseStrength: s.writingTarget, fsrsGrade: 'good' })]);
    // A low-confidence finding gives nothing, so the target 本 still counts as used correctly.
    expect(ev('本')).toEqual([expect.objectContaining({ direction: 'positive', baseStrength: s.writingTarget, fsrsGrade: 'good' })]);
    for (const w of ['私', '毎日', '読む']) expect(ev(w)).toEqual([expect.objectContaining({ direction: 'positive', baseStrength: s.writingUsed, fsrsGrade: null })]);
    expect(direct.every((e) => e.context.startsWith('writing:'))).toBe(true);
    // At most one event per item and direction (besides the half-weight recognition copy of positives).
    const keys = direct.map((e) => `${e.itemId}|${e.direction}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(a.outcome).toBe('wrong');
    expect(a.gradeId).toBeDefined();
  });

  it('a clean answer is correct and never sends the word back to be taught', async () => {
    const { engine } = await learner([CLEAN]);
    const { sessionId, activityId } = await writeOnce(engine);
    await engine.submitWriting(activityId, ANSWER);
    expect(engine.learner.activities.get(activityId)!.outcome).toBe('correct');
    await engine.completeActivity(activityId);
    const next = await engine.nextActivity(sessionId);
    if (!next.done) expect(next.activity.reason).not.toBe('missed, teach it');
  });

  it('records errors, counting repeats', async () => {
    const { engine } = await learner([RECORDED]);
    for (let k = 0; k < 2; k++) {
      const { activityId } = await writeOnce(engine);
      await engine.submitWriting(activityId, ANSWER);
    }
    const errors = [...engine.learner.errors.values()];
    expect(errors.map((e) => [e.itemId, e.errorType, e.quote, e.timesSeen])).toEqual([
      ['grammar:wo-object', 'particle', 'が', 2],
      [id('飲む'), 'conjugation', '飲むました', 2],
      [id('友達'), 'word_choice', '友達', 2],
    ]);
    expect(errors[0]).toMatchObject({ sentence: S1, singleErrorSentence: '私は毎日コーヒーが飲みました。', correction: 'を', confidence: 'high' });
  });

  it('replays to the same state from the stored grade, without calling the model', async () => {
    const { engine, llm, make } = await learner([RECORDED]);
    const { activityId } = await writeOnce(engine);
    await engine.submitWriting(activityId, ANSWER);
    expect(llm.call).toHaveBeenCalledTimes(1);
    const offline: Llm = { call: vi.fn(async () => { throw new Error('no model on replay'); }) };
    const again = await make(offline);
    expect(again.learner.evidence).toEqual(engine.learner.evidence);
    expect([...again.learner.states.entries()]).toEqual([...engine.learner.states.entries()]);
    expect([...again.learner.errors.entries()]).toEqual([...engine.learner.errors.entries()]);
    expect(again.learner.activities.get(activityId)).toEqual(engine.learner.activities.get(activityId));
    expect(offline.call).not.toHaveBeenCalled();
  });

  it('a flagged activity gives no evidence and no error records, and stays graded', async () => {
    const { engine, llm, make } = await learner([RECORDED]);
    const { activityId } = await writeOnce(engine);
    const g = await engine.submitWriting(activityId, ANSWER);
    expect(engine.learner.activities.get(activityId)!.evidence.length).toBeGreaterThan(0);
    await engine.flagContent(activityId, 'the grading is wrong');
    const a = engine.learner.activities.get(activityId)!;
    expect(a.evidence).toEqual([]);
    expect(engine.learner.errors.size).toBe(0);
    // Still attached to its grade, so it cannot be graded (and billed) again.
    expect(a).toMatchObject({ gradeId: g.id, outcome: 'skip' });
    await expect(engine.regrade(activityId)).rejects.toThrow(/already graded/);
    expect(llm.call).toHaveBeenCalledTimes(1);
    expect((await make(llm)).learner.activities.get(activityId)).toMatchObject({ gradeId: g.id, outcome: 'skip', evidence: [] });
  });

  it('a second submit or regrade while one is in flight is refused, with one answer and one call', async () => {
    const { engine, store, grades, llm } = await learner([RECORDED]);
    const { activityId } = await writeOnce(engine);
    const first = engine.submitWriting(activityId, ANSWER);
    await expect(engine.submitWriting(activityId, ANSWER)).rejects.toThrow(/being graded/);
    await expect(engine.regrade(activityId)).rejects.toThrow(/being graded/);
    const g = await first;
    expect(llm.call).toHaveBeenCalledTimes(1);
    expect(grades.grades).toEqual([g]);
    expect(store.events.filter((e) => e.kind === 'answer' && e.activityId === activityId)).toHaveLength(1);
    expect(store.events.filter((e) => e.kind === 'writing_graded')).toHaveLength(1);
  });

  it('a failed regrade releases the activity so it can be tried again', async () => {
    const { engine } = await learner([new Error('down'), new Error('still down'), RECORDED]);
    const { activityId } = await writeOnce(engine);
    await expect(engine.submitWriting(activityId, ANSWER)).rejects.toThrow(/down/);
    await expect(engine.regrade(activityId)).rejects.toThrow(/still down/);
    await expect(engine.regrade(activityId)).resolves.toMatchObject({ answer: ANSWER });
  });

  it('puts a lemma only on the word it names, never on a neighbour in the quote', async () => {
    const reply = {
      findings: [
        // A particle error quoted with its noun: the particle is not tracked, so nothing is blamed.
        { quote: 'コーヒーが', lemma: 'が', grammarPoint: null, errorType: 'particle', correction: 'コーヒーを', explanation: 'x', confidence: 'high' },
        // A lemma the catalog lacks does not fall onto 本.
        { quote: '本を', lemma: 'ほげ', grammarPoint: null, errorType: 'word_choice', correction: '雑誌を', explanation: 'x', confidence: 'high' },
      ],
      corrected: ANSWER,
      targetsUsed: [],
      comment: '',
    };
    const { engine } = await learner([reply]);
    const { activityId } = await writeOnce(engine);
    const g = await engine.submitWriting(activityId, ANSWER);
    expect(g.findings.map((f) => [f.quote, f.begin, f.itemId])).toEqual([
      ['コーヒーが', 4, undefined],
      ['本を', 18, undefined],
    ]);
    const a = engine.learner.activities.get(activityId)!;
    expect(a.evidence.filter((e) => e.direction === 'negative')).toEqual([]);
    expect(engine.learner.errors.size).toBe(0);
  });

  it('two different quotes starting at the same place both get their span', async () => {
    const reply = {
      findings: [
        { quote: '友達', lemma: '友達', grammarPoint: null, errorType: 'word_choice', correction: '友人', explanation: 'x', confidence: 'medium' },
        { quote: '友達と', lemma: null, grammarPoint: null, errorType: 'particle', correction: '友達とは', explanation: 'x', confidence: 'medium' },
        // The same quote twice goes to its next occurrence, or none.
        { quote: '友達', lemma: '友達', grammarPoint: null, errorType: 'other', correction: '友人', explanation: 'x', confidence: 'low' },
      ],
      corrected: ANSWER,
      targetsUsed: [],
      comment: '',
    };
    const { engine } = await learner([reply]);
    const { activityId } = await writeOnce(engine);
    const g = await engine.submitWriting(activityId, ANSWER);
    expect(g.findings.map((f) => [f.quote, f.begin, f.end])).toEqual([
      ['友達', 15, 17],
      ['友達と', 15, 18],
      ['友達', null, null],
    ]);
  });

  it('a missing particle, quoted as the word before the gap, is placed and recorded', async () => {
    // The learner left out を after 本; following the prompt's rule, the grader quotes 本 and corrects it to 本を.
    const answer = '友達と本読みます。';
    const toks = tokens([
      ['友達', '友達', 'ともだち', '名詞'],
      ['と', 'と', 'と', '助詞'],
      ['本', '本', 'ほん', '名詞'],
      ['読み', '読む', 'よみ', '動詞'],
      ['ます', 'ます', 'ます', '助動詞'],
      ['。', '。', '', '補助記号'],
    ]);
    const reply = {
      findings: [{ quote: '本', lemma: null, grammarPoint: 'wo-object', errorType: 'particle', correction: '本を', explanation: 'The object takes を.', confidence: 'high' }],
      corrected: S2,
      targetsUsed: [],
      comment: '',
    };
    const g = await mapGrade(reply, { answer, targets: [] }, { tokenizer: { analyze: async () => toks }, dictionary }, catalog);
    expect(g.findings[0]).toMatchObject({ itemId: 'grammar:wo-object', begin: 3, end: 4, singleErrorSentence: answer });
  });

  it('a failed call leaves the activity ungraded, and regrade grades the same answer', async () => {
    const { engine, store, grades, requests } = await learner([new Error('network down'), RECORDED]);
    const { activityId } = await writeOnce(engine);
    await expect(engine.submitWriting(activityId, ANSWER)).rejects.toThrow(/Grading failed: network down/);
    const a = engine.learner.activities.get(activityId)!;
    expect(a.gradeId).toBeUndefined();
    expect(a.evidence).toEqual([]);
    expect(grades.grades).toHaveLength(0);
    const g = await engine.regrade(activityId);
    expect(g.answer).toBe(ANSWER);
    expect(requests).toHaveLength(2);
    expect(store.events.filter((e) => e.kind === 'answer' && e.activityId === activityId)).toHaveLength(1);
    expect(store.events.filter((e) => e.kind === 'writing_graded')).toHaveLength(1);
    await expect(engine.submitWriting(activityId, ANSWER)).rejects.toThrow(/already graded/);
    await expect(engine.regrade(activityId)).rejects.toThrow(/already graded/);
  });

  it('a reply that is not a grade, or an answer the tokenizer cannot read, fails cleanly', async () => {
    const { engine, grades } = await learner(['not json', RECORDED]);
    const { activityId } = await writeOnce(engine);
    await expect(engine.submitWriting(activityId, ANSWER)).rejects.toThrow(/not a grade/);
    const other = await writeOnce(engine);
    await expect(engine.submitWriting(other.activityId, 'ほかの文。')).rejects.toThrow(/while reading the answer/);
    expect(grades.grades).toHaveLength(0);
    expect(engine.learner.activities.get(activityId)!.gradeId).toBeUndefined();
  });

  it('only writing activities take written answers to grade', async () => {
    const { engine } = await learner([RECORDED]);
    const { sessionId } = await engine.startSession(5);
    const v = await engine.startActivity(sessionId, { type: 'retrieval', itemId: id('本'), cue: 'ja_to_en', purpose: 'review', showFurigana: false });
    await expect(engine.submitWriting(v.activityId, ANSWER)).rejects.toThrow(/not free writing/);
  });
});
