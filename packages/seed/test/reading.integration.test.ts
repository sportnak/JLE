import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  Engine,
  MemoryContentStore,
  MemoryEventStore,
  checkPassage,
  mapTokens,
  parseQuestions,
  type Dictionary,
  type DictionaryEntry,
  type EngineConfig,
  type Ids,
  type Item,
  type LibraryPassage,
  type Llm,
  type LlmRequest,
  type Token,
  type Tokenizer,
} from '@jle/engine';
import { LIBRARY, buildCatalog } from '../src/index';

const catalog = buildCatalog();
const starter = catalog
  .clusters()
  .filter((c) => c.id.startsWith('vocab-band-'))
  .sort((a, b) => a.order - b.order)
  .flatMap((c) => catalog.inCluster(c.id));
const word = (written: string) => starter.find((i) => i.written === written)!;

/** Tokens for a fixture passage; offsets follow from the surfaces. */
function tokens(parts: [surface: string, lemma: string, reading: string, lemmaReading: string, pos0: string][]): Token[] {
  let at = 0;
  return parts.map(([surface, lemma, reading, lemmaReading, pos0]) => {
    const t: Token = {
      surface,
      dictionaryForm: lemma,
      normalizedForm: lemma,
      reading,
      dictionaryReading: lemmaReading,
      pos: [pos0, '*', '*', '*', '*', '*'],
      begin: at,
      end: at + [...surface].length,
      oov: false,
    };
    at = t.end;
    return t;
  });
}

const EASY = '私は毎日コーヒーを飲みます。';
const HARD = '私は昨夜、珍しい骨董品を鑑定しました。';
const TOKENS: Record<string, Token[]> = {
  [EASY]: tokens([
    ['私', '私', 'わたし', 'わたし', '代名詞'],
    ['は', 'は', 'は', 'は', '助詞'],
    ['毎日', '毎日', 'まいにち', 'まいにち', '名詞'],
    ['コーヒー', 'コーヒー', 'こーひー', 'こーひー', '名詞'],
    ['を', 'を', 'を', 'を', '助詞'],
    ['飲み', '飲む', 'のみ', 'のむ', '動詞'],
    ['ます', 'ます', 'ます', 'ます', '助動詞'],
    ['。', '。', '', '', '補助記号'],
  ]),
  [HARD]: tokens([
    ['私', '私', 'わたし', 'わたし', '代名詞'],
    ['は', 'は', 'は', 'は', '助詞'],
    ['昨夜', '昨夜', 'さくや', 'さくや', '名詞'],
    ['、', '、', '', '', '補助記号'],
    ['珍しい', '珍しい', 'めずらしい', 'めずらしい', '形容詞'],
    ['骨董品', '骨董品', 'こっとうひん', 'こっとうひん', '名詞'],
    ['を', 'を', 'を', 'を', '助詞'],
    ['鑑定', '鑑定', 'かんてい', 'かんてい', '名詞'],
    ['し', 'する', 'し', 'する', '動詞'],
    ['まし', 'ます', 'まし', 'ます', '助動詞'],
    ['た', 'た', 'た', 'た', '助動詞'],
    ['。', '。', '', '', '補助記号'],
  ]),
};

const tokenizer: Tokenizer = {
  analyze: async (text) => {
    const t = TOKENS[text];
    if (!t) throw new Error(`no fixture tokens for ${text}`);
    return t;
  },
};

/** Starter words by their written form, plus a few rare words the built-in list lacks. */
const RARE: Record<string, DictionaryEntry> = {
  昨夜: { id: 990001, written: '昨夜', reading: 'さくや', freqRank: 30000, pos: ['n'], gloss: ['last night'] },
  珍しい: { id: 990002, written: '珍しい', reading: 'めずらしい', freqRank: 25000, pos: ['adj-i'], gloss: ['unusual; rare'] },
  骨董品: { id: 990003, written: '骨董品', reading: 'こっとうひん', freqRank: 40000, pos: ['n'], gloss: ['antique'] },
  鑑定: { id: 990004, written: '鑑定', reading: 'かんてい', freqRank: 35000, pos: ['n', 'vs'], gloss: ['appraisal'] },
};
const dictionary: Dictionary = {
  lookup: async (keys) =>
    keys.map(({ lemma }) => {
      if (RARE[lemma]) return RARE[lemma]!;
      const item = starter.find((i) => i.written === lemma);
      return item ? { id: Number(item.id.slice('jmdict:'.length)), written: item.written, reading: item.reading, freqRank: item.tags.freq ?? null, pos: [], gloss: item.gloss } : null;
    }),
};

/** Writes the given passages in turn; reviews pass unless `verdicts` says false for that review. */
function fakeLlm(texts: string[], verdicts: boolean[] = [true]) {
  const requests: LlmRequest[] = [];
  const reviews: LlmRequest[] = [];
  let i = 0;
  const llm: Llm = {
    call: vi.fn(async (route, request: LlmRequest) => {
      if (route === 'review') {
        reviews.push(request);
        const bad = verdicts[Math.min(reviews.length - 1, verdicts.length - 1)] === false;
        return { output: { natural: !bad, translationMatches: true, questionsOk: true, problems: bad ? ['「骨董品を鑑定しました」は不自然です'] : [] }, stopReason: 'end_turn', model: 'claude-sonnet-5-5', callId: `review-${reviews.length}` };
      }
      requests.push(request);
      const text = texts[Math.min(i++, texts.length - 1)]!;
      const questions = [
        { question: 'What does the writer drink?', options: ['Coffee', 'Tea', 'Water'], answer: 0, word: 'コーヒー' },
        { question: 'Is it every day?', options: ['Yes', 'No', 'Only on Sundays'], answer: 0, word: '' },
      ];
      return { output: { title: '朝', text, translation: 'A passage.', questions }, stopReason: 'end_turn', model: 'claude-opus-5-5', callId: `call-${i}` };
    }),
  };
  return { llm, requests, reviews };
}

const seqIds = (): Ids => {
  let n = 0;
  return { next: () => `id-${++n}` };
};

const config: EngineConfig = { ...DEFAULT_CONFIG, reading: { ...DEFAULT_CONFIG.reading, targets: 0 } };

const EASY_WORDS = ['毎日', 'コーヒー', '飲む'];

/**
 * A learner who has met the first `met` starter words plus `extra` (marked known, so each has a read state).
 * By default that includes every word of the easy passage.
 */
async function learner(
  texts: string[],
  met = 25,
  extra: string[] = EASY_WORDS,
  cfg: EngineConfig = config,
  opts: { model?: boolean; library?: LibraryPassage[]; verdicts?: boolean[] } = {},
) {
  let t = new Date('2026-11-01T09:00:00Z').getTime();
  const clock = { now: () => new Date(t), advance: (ms: number) => (t += ms) };
  const store = new MemoryEventStore();
  const contents = new MemoryContentStore();
  const { llm, requests, reviews } = fakeLlm(texts, opts.verdicts);
  const make = (l: Llm | null) =>
    Engine.create({
      catalog,
      store,
      contents,
      learnerId: 'me',
      clock,
      ids: seqIds(),
      utcOffsetMinutes: 0,
      config: cfg,
      ...(l ? { llm: l } : {}),
      tokenizer,
      dictionary,
      ...(opts.library ? { library: opts.library } : {}),
    });
  const engine = await make(opts.model === false ? null : llm);
  // Every kana is known (overrides are instant), as for any learner reading passages.
  for (const c of catalog.clusters().filter((k) => k.track === 'script')) for (const k of catalog.inCluster(c.id)) await engine.overrideItem(k.id);
  for (const item of starter.slice(0, met)) await engine.overrideItem(item.id);
  for (const w of extra) await engine.overrideItem(word(w).id);
  return { engine, clock, store, contents, llm, requests, reviews, make };
}

/** Runs a session to its end, answering everything right and reading any passage without lookups. */
async function session(engine: Engine, clock: { advance(ms: number): void }, onReading?: (activityId: string) => Promise<void>) {
  let { sessionId, next } = await engine.startSession(10);
  const types: string[] = [];
  let guard = 0;
  while (!next.done && guard++ < 300) {
    const v = next.activity;
    types.push(v.spec.type);
    if (v.spec.type === 'reading') {
      if (onReading) await onReading(v.activityId);
      await engine.finishReading(v.activityId, 30_000);
    } else if (v.spec.type === 'retrieval') {
      await engine.recordInteraction(v.activityId, { kind: 'answer', text: v.spec.cue === 'ja_to_en' ? v.item.gloss[0]! : v.item.reading, latencyMs: 2000 });
    } else if (v.spec.type !== 'introduce') {
      await engine.recordInteraction(v.activityId, { kind: 'dont_know', latencyMs: 2000 });
    }
    clock.advance(8000);
    await engine.completeActivity(v.activityId);
    next = await engine.nextActivity(sessionId);
  }
  return { sessionId, types };
}

describe('generated reading', () => {
  it('stores a passage that passes its checks, and a lesson then offers it once', async () => {
    const { engine, clock, contents } = await learner([EASY]);
    const outcome = await engine.prepareReading();
    expect(outcome.status).toBe('ready');
    expect(contents.contents).toHaveLength(1);
    const c = contents.contents[0]!;
    expect(c.text).toBe(EASY);
    expect(c.tokens.filter((t) => t.itemId).map((t) => t.surface)).toEqual(['私', '毎日', 'コーヒー', '飲み']);
    expect(c.coverage).toBe(1);

    const { types } = await session(engine, clock);
    expect(types.filter((t) => t === 'reading')).toHaveLength(1);
    expect(engine.learner.unreadContent()).toHaveLength(0);
  });

  it('retries with a note naming the hard words, and never sends the known-word list', async () => {
    const { engine, requests } = await learner([HARD, EASY]);
    const outcome = await engine.prepareReading();
    expect(outcome).toMatchObject({ status: 'ready', tries: 2 });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.user).toContain('骨董品');
    for (const r of requests) {
      expect(r.system).not.toMatch(/学生|先生/);
      // Met words that are not targets never appear in a request.
      for (const w of starter.slice(5, 25)) expect(r.user.includes(w.written) && w.written.length > 1, w.written).toBe(false);
    }
  });

  it('gives up after the allowed retries and stores nothing', async () => {
    const { engine, contents, requests } = await learner([HARD]);
    const outcome = await engine.prepareReading();
    expect(outcome.status).toBe('failed');
    expect(requests).toHaveLength(1 + config.reading.retries);
    expect(contents.contents).toHaveLength(0);
  });

  it('waits until enough words are met', async () => {
    const { engine, llm } = await learner([EASY], 5, []);
    expect((await engine.prepareReading()).status).toBe('skipped');
    expect(llm.call).not.toHaveBeenCalled();
  });

  it('a failed model call is a failed passage, not an error in the lesson', async () => {
    const { engine } = await learner([EASY]);
    const broken = await Engine.create({
      catalog,
      store: new MemoryEventStore(),
      contents: new MemoryContentStore(),
      learnerId: 'me',
      config,
      llm: { call: async () => Promise.reject(new Error('refused')) },
      tokenizer,
      dictionary,
    });
    for (const item of starter.slice(0, 25)) await broken.overrideItem(item.id);
    expect((await broken.prepareReading()).status).toBe('failed');
    expect(engine).toBeTruthy();
  });
});

describe('reading evidence', () => {
  it('a lookup is a weak miss and queues the word; finishing credits only words already met', async () => {
    // The learner has met 私 and 毎日 but not コーヒー or 飲む; the passage is let through at half coverage.
    const loose: EngineConfig = { ...config, reading: { ...config.reading, coverage: 0.5 } };
    const { engine, clock } = await learner([EASY], 25, ['毎日'], loose);
    expect((await engine.prepareReading()).status).toBe('ready');
    const coffee = word('コーヒー');
    const drink = word('飲む');
    const before = engine.learner.state(word('毎日').id, 'read').pKnown;

    await session(engine, clock, async (activityId) => {
      await engine.lookup(activityId, 3); // コーヒー
      await engine.lookup(activityId, 3); // a second tap on the same word counts once
    });

    const reading = [...engine.learner.activities.values()].find((a) => a.spec.type === 'reading')!;
    const byItem = (id: string) => reading.evidence.filter((e) => e.itemId === id);
    expect(byItem(coffee.id)).toEqual([expect.objectContaining({ skill: 'read', direction: 'negative', baseStrength: config.strengths.lookup })]);
    expect(byItem(drink.id)).toEqual([]);
    expect(byItem(word('毎日').id)).toEqual([expect.objectContaining({ direction: 'positive', baseStrength: config.strengths.readPast, fsrsGrade: null })]);
    expect(engine.learner.state(word('毎日').id, 'read').pKnown).toBeGreaterThan(before);
    expect(engine.learner.wanted.has(coffee.id)).toBe(true);

    // The looked-up word is taught after the lookup, ahead of the frequency order (here, later in the same lesson).
    const all = [...engine.learner.activities.values()];
    const after = all.slice(all.indexOf(reading) + 1);
    const intros = after.filter((a) => a.spec.type === 'introduce').map((a) => a.spec.itemId);
    expect(after.find((a) => a.spec.type === 'introduce' && a.spec.itemId === coffee.id)).toBeTruthy();
    expect(intros).toContain(coffee.id);
  });

  it('replays to the same state from the log and stored content, without calling the model', async () => {
    const { engine, clock, store, contents, make } = await learner([EASY]);
    await engine.prepareReading();
    await session(engine, clock, async (activityId) => engine.lookup(activityId, 5));
    const silent: Llm = { call: vi.fn(async () => Promise.reject(new Error('must not be called'))) };
    const replayed = await make(silent);
    expect(replayed.log.length).toBe(store.events.length);
    expect([...replayed.learner.states.entries()]).toEqual([...engine.learner.states.entries()]);
    expect([...replayed.learner.wanted]).toEqual([...engine.learner.wanted]);
    expect(replayed.learner.contents.size).toBe(contents.contents.length);
    expect(silent.call).not.toHaveBeenCalled();
  });

  it('words beyond the built-in list join the catalog from stored content, outside placement and the frontier', async () => {
    const { engine } = await learner([HARD, HARD, HARD]);
    await engine.prepareReading();
    // HARD fails, so check mapping directly through a passage built on it.
    const model = engine.learner;
    const mapped = await (await import('@jle/engine')).mapTokens(TOKENS[HARD]!, dictionary, model.catalog);
    const rare = mapped.items.filter((i: Item) => i.cluster === 'reading-extra').map((i: Item) => i.written);
    expect(rare.sort()).toEqual(['昨夜', '珍しい', '骨董品', '鑑定'].sort());
    const check = checkPassage(model, HARD, mapped.tokens, [], config);
    expect(check.ok).toBe(false);
    expect(check.newWords).toEqual(expect.arrayContaining(['昨夜', '珍しい', '骨董品', '鑑定']));
    const extra = catalog.cluster('reading-extra')!;
    expect(extra.wantedOnly).toBe(true);
  });

  it('a passage missing a target word fails', async () => {
    const { engine } = await learner([EASY]);
    const model = engine.learner;
    const mapped = await (await import('@jle/engine')).mapTokens(TOKENS[EASY]!, dictionary, model.catalog);
    expect(checkPassage(model, EASY, mapped.tokens, [word('学生')], config)).toMatchObject({ ok: false, missingTargets: ['学生'] });
    expect(checkPassage(model, EASY, mapped.tokens, [word('コーヒー')], config).ok).toBe(true);
  });
});

describe('review fixes', () => {
  /** A learner with a passage open: 私 and 毎日 met, コーヒー and 飲む not. Returns the reading activity id. */
  async function openPassage() {
    const loose: EngineConfig = { ...config, reading: { ...config.reading, coverage: 0.5 } };
    const ctx = await learner([EASY], 25, ['毎日'], loose);
    await ctx.engine.prepareReading();
    const c = ctx.contents.contents[0]!;
    const { sessionId } = await ctx.engine.startSession(10);
    const view = await ctx.engine.startActivity(sessionId, { type: 'reading', itemId: word('毎日').id, purpose: 'practice', contentId: c.id, chars: [...c.text].length });
    return { ...ctx, activityId: view.activityId, sessionId };
  }

  it('events written without waiting still get distinct, ordered seqs', async () => {
    const { engine, store, activityId } = await openPassage();
    await Promise.all([engine.lookup(activityId, 3), engine.lookup(activityId, 5), engine.finishReading(activityId, 1000)]);
    const seqs = store.events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    const a = engine.learner.activities.get(activityId)!;
    expect(a.evidence.filter((e) => e.direction === 'negative').map((e) => e.itemId).sort()).toEqual([word('コーヒー').id, word('飲む').id].sort());
  });

  it('a lookup after Done is not logged', async () => {
    const { engine, store, activityId } = await openPassage();
    await engine.finishReading(activityId, 1000);
    const n = store.events.length;
    await engine.lookup(activityId, 3);
    expect(store.events.length).toBe(n);
    expect(engine.learner.wanted.size).toBe(0);
  });

  it('looking up a never-met word does not make it met', async () => {
    const { engine, activityId } = await openPassage();
    await engine.lookup(activityId, 3);
    const coffee = word('コーヒー');
    expect(engine.learner.state(coffee.id, 'read').status).toBe('unseen');
    expect(engine.learner.state(coffee.id, 'read').neg).toBeGreaterThan(0);
    await engine.finishReading(activityId, 1000);
    const a = engine.learner.activities.get(activityId)!;
    expect(a.evidence.filter((e) => e.itemId === coffee.id && e.direction === 'positive')).toEqual([]);
  });

  it('flagging a passage drops its lookups from the words to teach', async () => {
    const { engine, activityId } = await openPassage();
    await engine.lookup(activityId, 3);
    expect(engine.learner.wanted.size).toBe(1);
    await engine.flagContent(activityId, 'wrong word');
    expect(engine.learner.wanted.size).toBe(0);
  });

  it('a finished passage is read, not a right answer', async () => {
    const { engine, activityId } = await openPassage();
    await engine.finishReading(activityId, 1000);
    expect(engine.learner.activities.get(activityId)!.outcome).toBe('read');
  });

  it('a stored copy of a word the list no longer has goes to the extra group', () => {
    const c = buildCatalog();
    const stale: Item = { ...word('私'), id: 'jmdict:123456789', cluster: 'vocab-band-1' };
    c.extend([stale]);
    expect(c.item('jmdict:123456789')!.cluster).toBe('reading-extra');
    expect(c.inCluster('vocab-band-1').some((i) => i.id === 'jmdict:123456789')).toBe(false);
  });

  it('one new word in two forms counts once', async () => {
    const { engine } = await learner([EASY], 25, []);
    const drink = word('飲む');
    const tokens = [
      { surface: '飲み', reading: 'のみ', begin: 0, end: 2, itemId: drink.id },
      { surface: '飲んで', reading: 'のんで', begin: 2, end: 5, itemId: drink.id },
    ];
    expect(checkPassage(engine.learner, '飲み飲んで', tokens, [], config).newWords).toEqual(['飲む']);
  });
});

describe('review and offline reading', () => {
  const LIB: LibraryPassage[] = [
    { id: 'hard', level: 1, title: '骨董', text: HARD, translation: 'An antique.' },
    { id: 'easy', level: 2, title: '朝', text: EASY, translation: 'Every day coffee.' },
  ];

  it('every generated passage is reviewed, and the verdict is stored with it', async () => {
    const { engine, contents, reviews } = await learner([EASY]);
    expect((await engine.prepareReading()).status).toBe('ready');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.user).toContain(EASY);
    expect(contents.contents[0]!.review).toMatchObject({ model: 'claude-sonnet-5-5', natural: true, translationMatches: true });
  });

  it('a passage the reviewer rejects is written again with its notes', async () => {
    const { engine, requests, reviews } = await learner([EASY, EASY], 25, EASY_WORDS, config, { verdicts: [false, true] });
    expect(await engine.prepareReading()).toMatchObject({ status: 'ready', tries: 2 });
    expect(reviews).toHaveLength(2);
    expect(requests[1]!.user).toContain('A reviewer found problems');
  });

  it('without a model, the best-fitting library passage is used and stored like any other', async () => {
    const { engine, contents, clock } = await learner([], 25, EASY_WORDS, config, { model: false, library: LIB });
    const outcome = await engine.prepareReading();
    expect(outcome).toMatchObject({ status: 'ready' });
    expect(contents.contents.map((c) => [c.id, c.source])).toEqual([['library:easy', 'library']]);
    const { types } = await session(engine, clock);
    expect(types).toContain('reading');
  });

  it('a failed model run falls back to the library', async () => {
    const { engine, contents } = await learner([HARD], 25, EASY_WORDS, config, { library: LIB });
    expect((await engine.prepareReading()).status).toBe('ready');
    expect(contents.contents[0]!.source).toBe('library');
  });

  it('a library passage that does not fit is not offered', async () => {
    const { engine, contents } = await learner([], 0, [], config, { model: false, library: LIB });
    expect((await engine.prepareReading()).status).not.toBe('ready');
    expect(contents.contents).toHaveLength(0);
  });

  it('a passage read a few days ago comes back to be read again', async () => {
    const { engine, clock } = await learner([], 25, EASY_WORDS, config, { model: false, library: [LIB[1]!] });
    await engine.prepareReading();
    expect((await session(engine, clock)).types).toContain('reading');
    clock.advance(86_400_000);
    expect((await session(engine, clock)).types).not.toContain('reading');
    clock.advance(3 * 86_400_000);
    const { sessionId, types } = await session(engine, clock);
    expect(types).toContain('reading');
    const again = engine.learner.sessions.get(sessionId)!.activityIds.map((id) => engine.learner.activities.get(id)!).find((a) => a.spec.type === 'reading')!;
    expect(again.spec.type === 'reading' && again.spec.contentId).toBe('library:easy');
  });

  it('the built-in library is well formed', () => {
    expect(new Set(LIBRARY.map((p) => p.id)).size).toBe(LIBRARY.length);
    for (const p of LIBRARY) {
      expect(p.text, p.id).not.toMatch(/[A-Za-z]/);
      expect([...p.text].length, p.id).toBeGreaterThan(10);
      expect([...p.text].length, p.id).toBeLessThanOrEqual(400);
      expect(p.translation.length, p.id).toBeGreaterThan(5);
      expect(p.level, p.id).toBeGreaterThanOrEqual(1);
    }
    expect(new Set(LIBRARY.map((p) => p.level)).size).toBe(6);
  });
});

describe('mapping words the tokenizer reads another way', () => {
  const t = (surface: string, reading: string, pos0 = '代名詞') => tokens([[surface, surface, reading, reading, pos0]]);
  const entries: Record<string, DictionaryEntry> = {
    'わたくし': { id: 2842390, written: '私', reading: 'わたくし', freqRank: null, pos: ['pn'], gloss: ['I (formal)'] },
    'じ': { id: 2020680, written: '時', reading: 'じ', freqRank: null, pos: ['suf'], gloss: ["o'clock"] },
  };
  const dict: Dictionary = { lookup: async (keys) => keys.map((k) => entries[k.reading ?? ''] ?? null) };

  it('a rare reading of a listed word maps to the listed word', async () => {
    const mapped = await mapTokens(t('私', 'わたくし'), dict, catalog);
    expect(mapped.tokens[0]!.itemId).toBe(word('私').id);
  });

  it('an affix keeps its own entry', async () => {
    const mapped = await mapTokens(t('時', 'じ', '名詞'), dict, catalog);
    expect(mapped.tokens[0]!.itemId).toBe('jmdict:2020680');
  });
});

describe('questions on a passage', () => {
  /** Reads the waiting passage in a session, answering each question with `answer`. Returns the session's activities. */
  async function readAndAnswer(engine: Engine, clock: { advance(ms: number): void }, answer: (options: string[], right: string) => string | null) {
    let { sessionId, next } = await engine.startSession(10);
    for (let guard = 0; !next.done && guard < 300; guard++) {
      const v = next.activity;
      if (v.spec.type === 'reading') await engine.finishReading(v.activityId, 20_000);
      else if (v.spec.type === 'comprehension') {
        const pick = answer(v.spec.options, v.spec.answer);
        await engine.recordInteraction(v.activityId, pick === null ? { kind: 'dont_know', latencyMs: 3000 } : { kind: 'choice', choice: pick, latencyMs: 3000 });
      } else if (v.spec.type === 'retrieval') {
        await engine.recordInteraction(v.activityId, { kind: 'answer', text: v.spec.cue === 'ja_to_en' ? v.item.gloss[0]! : v.item.reading, latencyMs: 2000 });
      }
      clock.advance(8000);
      await engine.completeActivity(v.activityId);
      next = await engine.nextActivity(sessionId);
    }
    return engine.learner.sessions.get(sessionId)!.activityIds.map((id) => engine.learner.activities.get(id)!);
  }

  it('questions are stored with the passage and asked straight after it', async () => {
    const { engine, clock, contents } = await learner([EASY]);
    await engine.prepareReading();
    const qs = contents.contents[0]!.questions!;
    expect(qs).toHaveLength(2);
    expect(qs[0]).toMatchObject({ prompt: 'What does the writer drink?', answer: 0, itemId: word('コーヒー').id });
    expect(qs[1]!.itemId).toBeUndefined();
    const acts = await readAndAnswer(engine, clock, (_o, right) => right);
    const at = acts.findIndex((a) => a.spec.type === 'reading');
    expect(acts.slice(at + 1, at + 3).map((a) => a.spec.type)).toEqual(['comprehension', 'comprehension']);
    expect(acts.filter((a) => a.spec.type === 'comprehension')).toHaveLength(2);
  });

  it('a hinge question gives the word recognition evidence; a gist question gives none', async () => {
    const { engine, clock } = await learner([EASY]);
    await engine.prepareReading();
    const acts = await readAndAnswer(engine, clock, (options, right) => options.find((o) => o !== right)!);
    const [hinge, gist] = acts.filter((a) => a.spec.type === 'comprehension');
    expect(hinge!.outcome).toBe('wrong');
    expect(hinge!.evidence).toEqual([expect.objectContaining({ itemId: word('コーヒー').id, skill: 'read', direction: 'negative', baseStrength: config.strengths.comprehension, fsrsGrade: null })]);
    expect(gist!.evidence).toEqual([]);
  });

  it('options keep a fixed order, so replay shows the same question', async () => {
    const { engine, clock, make } = await learner([EASY]);
    await engine.prepareReading();
    await readAndAnswer(engine, clock, (_o, right) => right);
    const replayed = await make(null);
    const shown = (e: Engine) => [...e.learner.activities.values()].filter((a) => a.spec.type === 'comprehension').map((a) => a.spec);
    expect(shown(replayed)).toEqual(shown(engine));
    expect([...replayed.learner.states.entries()]).toEqual([...engine.learner.states.entries()]);
  });

  it('only well-formed questions are kept', () => {
    const targets = [word('コーヒー')];
    expect(
      parseQuestions(
        [
          { question: 'ok', options: ['a', 'b', 'c'], answer: 2, word: 'コーヒー' },
          { question: 'two options', options: ['a', 'b'], answer: 0, word: '' },
          { question: 'repeated', options: ['a', 'a', 'b'], answer: 0, word: '' },
          { question: 'out of range', options: ['a', 'b', 'c'], answer: 3, word: '' },
          { question: '', options: ['a', 'b', 'c'], answer: 0, word: '' },
        ],
        targets,
      ),
    ).toEqual([{ prompt: 'ok', options: ['a', 'b', 'c'], answer: 2, itemId: word('コーヒー').id }]);
  });

  it('a library passage brings its questions, hinged on its own words', async () => {
    const lib: LibraryPassage[] = [
      { id: 'easy', level: 2, title: '朝', text: EASY, translation: '…', questions: [{ question: 'What?', options: ['Coffee', 'Tea', 'Water'], answer: 0, word: 'コーヒー' }] },
    ];
    const { engine, contents } = await learner([], 25, EASY_WORDS, config, { model: false, library: lib });
    await engine.prepareReading();
    expect(contents.contents[0]!.questions).toEqual([{ prompt: 'What?', options: ['Coffee', 'Tea', 'Water'], answer: 0, itemId: word('コーヒー').id }]);
  });

  it('every library passage has a well-formed question', () => {
    for (const p of LIBRARY) {
      expect(p.questions?.length, p.id).toBeGreaterThan(0);
      for (const q of p.questions!) {
        expect(new Set(q.options).size, p.id).toBe(3);
        expect(q.answer >= 0 && q.answer < 3, p.id).toBe(true);
        expect(q.word.length, p.id).toBeGreaterThan(0);
      }
    }
  });
});

describe('polite prefixes', () => {
  const split = (noun: string, reading: string) => {
    const prefix = tokens([['お', 'お', 'お', 'お', '接頭辞']])[0]!;
    const n = { ...tokens([[noun, noun, reading, reading, '名詞']])[0]!, begin: 1, end: 1 + [...noun].length };
    return [prefix, n];
  };
  const tea = word('お茶');
  const dict: Dictionary = {
    lookup: async (keys) =>
      keys.map((k) =>
        k.lemma === 'お茶'
          ? { id: Number(tea.id.slice('jmdict:'.length)), written: 'お茶', reading: 'おちゃ', freqRank: tea.tags.freq ?? null, pos: ['n'], gloss: ['tea'] }
          : k.lemma === '茶'
            ? { id: 1427220, written: '茶', reading: 'ちゃ', freqRank: 5000, pos: ['n'], gloss: ['tea (plant)'] }
            : null,
      ),
  };

  it('お + 茶 is read as お茶, the word the learner learns', async () => {
    const mapped = await mapTokens(split('茶', 'ちゃ'), dict, catalog);
    expect(mapped.tokens).toEqual([{ surface: 'お茶', reading: 'おちゃ', begin: 0, end: 2, itemId: tea.id }]);
  });

  it('falls back to the bare noun when the joined word is not in the dictionary', async () => {
    const only: Dictionary = { lookup: async (keys) => keys.map((k) => (k.lemma === '茶' ? { id: 1427220, written: '茶', reading: 'ちゃ', freqRank: 5000, pos: ['n'], gloss: ['tea'] } : null)) };
    const mapped = await mapTokens(split('茶', 'ちゃ'), only, catalog);
    expect(mapped.tokens[0]).toMatchObject({ surface: 'お茶', itemId: 'jmdict:1427220' });
  });
});
