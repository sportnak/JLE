import type { EngineConfig } from '../config';
import type { LearnerModel } from '../learner';
import type { Dictionary, DictionaryEntry, Ids, Llm, LlmRequest, Token, Tokenizer } from '../ports';
import type { Catalog, ContentQuestion, ContentToken, Item, StoredContent } from '../types';

export const READING_PROMPT_VERSION = 'reading-2';
export const REVIEW_PROMPT_VERSION = 'review-2';

/** Where words beyond the built-in list go when a passage brings them in. Taught only if looked up. */
export const EXTRA_CLUSTER = 'reading-extra';

/**
 * The stable half of the prompt: cached by the host. It carries no learner state. The level and the target words
 * go in the user message, and the learner's known-word list is never sent (architecture §6).
 */
export const READING_SYSTEM = `You write very short Japanese reading passages for someone learning Japanese.

- Write natural, correct Japanese that a native speaker would accept without comment.
- Use the polite です/ます style.
- Use only very common everyday words and beginner grammar: です and ます forms, the past tense, い and な adjectives, the basic particles, and simple questions.
- Keep sentences short and concrete: people, places, food, times, everyday actions.
- Write each word the way it is normally written, with kanji where a native writer would use it.
- Never add readings, furigana, romaji, brackets or notes, and do not number sentences.

Return JSON with:
- title: a short Japanese title
- text: the passage, as one paragraph
- translation: a natural English translation of the passage
- questions: one or two multiple-choice questions, in English, about what the passage says. Each must need one of the listed words to answer: name that word in \`word\`, written exactly as listed. Give three short English options, exactly one of them right according to the passage, and the index (0 to 2) of the right one in \`answer\`.`;

export const READING_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    text: { type: 'string' },
    translation: { type: 'string' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          answer: { type: 'integer' },
          word: { type: 'string' },
        },
        required: ['question', 'options', 'answer', 'word'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'text', 'translation', 'questions'],
  additionalProperties: false,
};

/** The second look (route `review`, a different model): natural Japanese, a matching translation, sound questions. */
export const REVIEW_SYSTEM = `You check short Japanese reading passages written for beginners, before a learner sees them.

Judge three things:
- natural: every sentence is correct, natural Japanese a native speaker would accept: grammar, particles, word choice, counters, and a consistent polite style.
- translationMatches: the English says what the Japanese says, with nothing important added or left out.
- questionsOk: each question has exactly one option that is right according to the Japanese passage, and the others are clearly wrong.

List each concrete problem in problems, quoting the Japanese it concerns. Be strict about mistakes and unnatural phrasing; do not object to simple vocabulary or short sentences, which are intended. If there are no problems, return an empty list.`;

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    natural: { type: 'boolean' },
    translationMatches: { type: 'boolean' },
    questionsOk: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
  },
  required: ['natural', 'translationMatches', 'questionsOk', 'problems'],
  additionalProperties: false,
};

export function reviewRequest(title: string, text: string, translation: string, questions: ContentQuestion[], sessionId?: string): LlmRequest {
  const qs = questions.map((q, i) => `${i + 1}. ${q.prompt}\n${q.options.map((o, k) => `   ${'abc'[k]}) ${o}${k === q.answer ? '  (marked right)' : ''}`).join('\n')}`).join('\n');
  return {
    promptVersion: REVIEW_PROMPT_VERSION,
    system: REVIEW_SYSTEM,
    user: `Title: ${title}\n\nJapanese:\n${text}\n\nEnglish:\n${translation}\n\nQuestions:\n${qs || '(none)'}`,
    schema: REVIEW_SCHEMA,
    maxTokens: 4000,
    effort: 'medium',
    ...(sessionId ? { sessionId } : {}),
  };
}

const TOPICS = [
  'a morning at home',
  'buying lunch',
  'a friend who visits',
  'the weather today',
  'a weekend plan',
  'a trip by train',
  'a favourite food',
  'a day at school',
  'a small shop near the station',
  'a family dinner',
  'a walk in the park',
  'a phone call',
  'an evening at home',
  'a new book',
  'a café',
  'a rainy day',
];

/** Parts of speech that are words to track. Particles, auxiliaries, symbols and affixes are grammar or glue. */
const CONTENT_POS = new Set(['名詞', '動詞', '形容詞', '副詞', '形状詞', '連体詞', '感動詞', '代名詞']);

export function isTracked(t: Token): boolean {
  if (!CONTENT_POS.has(t.pos[0] ?? '')) return false;
  if (t.pos[1] === '数詞' || t.pos[1] === '固有名詞') return false;
  return /[぀-ヿ一-鿿]/.test(t.surface);
}

/** Met for recognition: introduced or further. */
const met = (model: LearnerModel, id: string) => model.state(id, 'read').status !== 'unseen';

/** Words the passage is written around: words being learned, most recently practised first. */
export function readingTargets(model: LearnerModel, n: number): Item[] {
  const used = new Map<string, number>();
  for (const c of model.contents.values()) for (const t of c.targets) used.set(t, (used.get(t) ?? 0) + 1);
  return [...model.states.values()]
    .filter((s) => s.skill === 'read' && (s.status === 'learning' || s.status === 'introduced'))
    .map((s) => ({ s, item: model.item(s.itemId) }))
    .filter((x): x is { s: (typeof x)['s']; item: Item } => x.item?.type === 'vocab')
    .sort((a, b) => (used.get(a.item.id) ?? 0) - (used.get(b.item.id) ?? 0) || (b.s.lastEvidenceAt ?? '').localeCompare(a.s.lastEvidenceAt ?? ''))
    .slice(0, n)
    .map((x) => x.item);
}

/** Recognition-met vocabulary size: a level, never the list itself. */
export function metWords(model: LearnerModel): number {
  let n = 0;
  for (const s of model.states.values()) if (s.skill === 'read' && s.status !== 'unseen' && model.item(s.itemId)?.type === 'vocab') n++;
  return n;
}

export function readingRequest(model: LearnerModel, targets: Item[], feedback: string | null, sessionId?: string): LlmRequest {
  const words = metWords(model);
  const topic = TOPICS[model.contents.size % TOPICS.length]!;
  const sentences = words < 150 ? '2 or 3 short sentences' : words < 400 ? '3 to 5 sentences' : '5 to 8 sentences';
  const lines = [
    `The learner reads hiragana and katakana and knows about ${Math.max(10, Math.round(words / 10) * 10)} everyday words.`,
    `Write ${sentences} about: ${topic}.`,
    targets.length
      ? `Use each of these words at least once, in any form:\n${targets.map((t) => `- ${t.written} (${t.reading}): ${t.gloss[0] ?? ''}`).join('\n')}`
      : '',
    'Apart from those, use only the most common words a beginner meets first.',
    feedback ?? '',
  ];
  return {
    promptVersion: READING_PROMPT_VERSION,
    system: READING_SYSTEM,
    user: lines.filter(Boolean).join('\n\n'),
    schema: READING_SCHEMA,
    maxTokens: 8000,
    effort: 'low',
    ...(sessionId ? { sessionId } : {}),
  };
}

/** An item for a dictionary entry the built-in list lacks. It lives in the extra cluster and is taught only if looked up. */
export function itemFromEntry(e: DictionaryEntry): Item {
  return {
    id: `jmdict:${e.id}`,
    language: 'ja',
    type: 'vocab',
    written: e.written,
    reading: e.reading,
    gloss: e.gloss.flatMap((g) => g.split(/;\s*/)).filter(Boolean).slice(0, 8),
    skills: ['read', 'write', 'listen'],
    cluster: EXTRA_CLUSTER,
    order: 1_000_000 + (e.freqRank ?? 900_000),
    tags: e.freqRank ? { freq: e.freqRank } : {},
  };
}

const AFFIX_POS = new Set(['suf', 'n-suf', 'pref', 'n-pref', 'ctr']);

/**
 * The tokenizer sometimes reads a common word another way (私 as わたくし, 何 as なん), which lands on a rare entry for the
 * same written word. When the matched entry is unranked and not an affix or counter, and the word list has a word written
 * the same way, that listed word is meant. An affix such as 時 (じ, o'clock) keeps its own entry.
 */
function listedSameWord(catalog: Catalog, lemma: string, entry: DictionaryEntry): Item | undefined {
  if (entry.freqRank !== null || entry.pos.some((p) => AFFIX_POS.has(p))) return undefined;
  return catalog.byWritten(lemma).find((i) => i.type === 'vocab' && i.cluster !== EXTRA_CLUSTER);
}

/**
 * Maps tracked tokens to items through the host's dictionary. Words it cannot find stay untracked. Every item it maps
 * to is returned, so stored content replays the same even if the built-in word list changes later.
 */
const POLITE_PREFIX = new Set(['お', 'ご', '御']);

/**
 * Sudachi splits a polite prefix from its noun (お茶 → お + 茶), but the dictionary lists the joined word, and that is the
 * word a learner learns. A prefix and the noun after it become one token; mapping falls back to the noun alone when the
 * dictionary has no joined entry.
 */
export function joinPrefixes(tokens: Token[]): { token: Token; bare?: Token }[] {
  const out: { token: Token; bare?: Token }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const next = tokens[i + 1];
    if (t.pos[0] === '接頭辞' && POLITE_PREFIX.has(t.surface) && next && next.pos[0] === '名詞') {
      out.push({
        token: {
          ...next,
          surface: t.surface + next.surface,
          dictionaryForm: t.surface + next.dictionaryForm,
          normalizedForm: t.surface + next.normalizedForm,
          reading: t.reading + next.reading,
          dictionaryReading: t.reading + next.dictionaryReading,
          begin: t.begin,
        },
        bare: next,
      });
      i++;
    } else out.push({ token: t });
  }
  return out;
}

export async function mapTokens(
  raw: Token[],
  dictionary: Dictionary,
  catalog: Catalog,
): Promise<{ tokens: ContentToken[]; items: Item[] }> {
  const units = joinPrefixes(raw);
  const tokens = units.map((u) => u.token);
  const tracked = tokens.map((t, i) => [t, i] as const).filter(([t]) => isTracked(t));
  const joined = await dictionary.lookup(tracked.map(([t]) => ({ lemma: t.dictionaryForm, reading: t.dictionaryReading })));
  // Joined words the dictionary lacks are looked up again as the bare noun.
  const retry = tracked.map(([, i], k) => (!joined[k] && units[i]!.bare ? k : -1)).filter((k) => k >= 0);
  const bare = retry.length
    ? await dictionary.lookup(retry.map((k) => units[tracked[k]![1]]!.bare!).map((b) => ({ lemma: b.dictionaryForm, reading: b.dictionaryReading })))
    : [];
  const found = joined.map((e, k) => e ?? bare[retry.indexOf(k)] ?? null);
  const itemAt = new Map<number, Item>();
  const items = new Map<string, Item>();
  tracked.forEach(([, i], k) => {
    const entry = found[k];
    if (!entry) return;
    const item = catalog.item(`jmdict:${entry.id}`) ?? listedSameWord(catalog, tokens[i]!.dictionaryForm, entry) ?? itemFromEntry(entry);
    itemAt.set(i, item);
    items.set(item.id, item);
  });
  return {
    tokens: tokens.map((t, i) => ({
      surface: t.surface,
      reading: t.reading,
      begin: t.begin,
      end: t.end,
      ...(itemAt.has(i) ? { itemId: itemAt.get(i)!.id } : {}),
    })),
    items: [...items.values()],
  };
}

export interface PassageCheck {
  ok: boolean;
  coverage: number;
  newWords: string[];
  missingTargets: string[];
  reason: string;
}

/** The deterministic gate: enough met words, few new ones, every target used, no romaji, a sensible length. */
export function checkPassage(model: LearnerModel, text: string, tokens: ContentToken[], targets: Item[], config: EngineConfig): PassageCheck {
  const targetIds = new Set(targets.map((t) => t.id));
  const tracked = tokens.filter((t) => t.itemId);
  const known = tracked.filter((t) => targetIds.has(t.itemId!) || met(model, t.itemId!)).length;
  const coverage = tracked.length ? known / tracked.length : 0;
  const unmet = [...new Set(tracked.filter((t) => !targetIds.has(t.itemId!) && !met(model, t.itemId!)).map((t) => t.itemId!))];
  // One word in several forms (食べ, 食べて) is one new word, named by its dictionary form.
  const newWords = unmet.map((id) => model.item(id)?.written ?? tracked.find((t) => t.itemId === id)!.surface);
  const present = new Set(tracked.map((t) => t.itemId));
  const missingTargets = targets.filter((t) => !present.has(t.id)).map((t) => t.written);
  const chars = [...text].length;
  const reasons = [
    /[A-Za-zＡ-Ｚａ-ｚ]/.test(text) ? 'it contains Latin letters' : '',
    chars < 10 || chars > 400 ? `it is ${chars} characters long` : '',
    tracked.length === 0 ? 'no words were recognised' : '',
    coverage < config.reading.coverage ? `coverage ${Math.round(coverage * 100)}%` : '',
    newWords.length > config.reading.maxNewWords ? `${newWords.length} new words` : '',
    missingTargets.length ? `missing ${missingTargets.join('、')}` : '',
  ].filter(Boolean);
  return { ok: reasons.length === 0, coverage, newWords, missingTargets, reason: reasons.join('; ') };
}

/** What the next try is told when a passage fails: which words were too hard or missing. Never the known list. */
function retryNote(check: PassageCheck): string {
  const parts = [];
  if (check.newWords.length) parts.push(`The last version used words that are too hard for this learner: ${check.newWords.join('、')}. Use simpler, more common words instead.`);
  if (check.missingTargets.length) parts.push(`It also left out: ${check.missingTargets.join('、')}. Use every listed word.`);
  return parts.join(' ') || 'Write a new, simpler version.';
}

/**
 * Questions from the model's reply that are well formed: three distinct options and an answer in range. A question
 * naming one of `words` (the passage's own items) hinges on it; any other is a gist question with no item evidence.
 */
export function parseQuestions(raw: unknown, words: Item[]): ContentQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q): ContentQuestion[] => {
    if (!q || typeof q !== 'object') return [];
    const { question, options, answer, word } = q as Record<string, unknown>;
    if (typeof question !== 'string' || !question.trim() || !Array.isArray(options)) return [];
    const opts = options.filter((o): o is string => typeof o === 'string').map((o) => o.trim());
    if (opts.length !== 3 || new Set(opts).size !== 3 || opts.some((o) => !o)) return [];
    if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0 || answer > 2) return [];
    const hinge = typeof word === 'string' && word.trim() ? words.find((t) => t.written === word.trim() || t.reading === word.trim()) : undefined;
    return [{ prompt: question.trim(), options: opts, answer, ...(hinge ? { itemId: hinge.id } : {}) }];
  }).slice(0, 2);
}

export interface ReadingPorts {
  llm: Llm;
  tokenizer: Tokenizer;
  dictionary: Dictionary;
}

export type ReadingOutcome =
  | { status: 'ready'; content: StoredContent; tries: number }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string; tries: number };

/**
 * Generate → tokenize → map → check, retrying with a note on what failed. Returns the content to store, or why
 * there is none. Nothing here touches learner state; the caller stores the content and adds it to the model.
 */
export async function writeReading(
  ports: ReadingPorts,
  model: LearnerModel,
  opts: { learnerId: string; now: Date; ids: Ids; sessionId?: string },
): Promise<ReadingOutcome> {
  const cfg = model.config.reading;
  if (metWords(model) < cfg.minMetWords) return { status: 'skipped', reason: `fewer than ${cfg.minMetWords} words met` };
  const targets = readingTargets(model, cfg.targets);
  let feedback: string | null = null;
  let last = 'no attempt';
  for (let tries = 1; tries <= cfg.retries + 1; tries++) {
    let result;
    try {
      result = await ports.llm.call('generate', readingRequest(model, targets, feedback, opts.sessionId));
    } catch (e) {
      return { status: 'failed', reason: `the model call failed: ${String(e)}`, tries };
    }
    const out = result.output as { title?: unknown; text?: unknown; translation?: unknown; questions?: unknown } | null;
    if (!out || typeof out.text !== 'string' || typeof out.title !== 'string' || typeof out.translation !== 'string') {
      last = 'the reply was not a passage';
      continue;
    }
    const text = out.text.trim();
    const mapped = await mapTokens(await ports.tokenizer.analyze(text), ports.dictionary, model.catalog);
    const check = checkPassage(model, text, mapped.tokens, targets, model.config);
    if (!check.ok) {
      last = check.reason;
      feedback = retryNote(check);
      continue;
    }
    // A question may hinge on any word the passage actually uses, listed target or not.
    const questions = parseQuestions(out.questions, mapped.items);
    if (questions.length === 0) {
      last = 'no usable question';
      feedback = 'The last version had no usable question. Include one or two questions as described, each with three different options.';
      continue;
    }
    let review: StoredContent['review'];
    if (cfg.review) {
      let verdict;
      try {
        verdict = await ports.llm.call('review', reviewRequest(out.title, text, out.translation, questions, opts.sessionId));
      } catch (e) {
        return { status: 'failed', reason: `the review call failed: ${String(e)}`, tries };
      }
      const v = verdict.output as { natural?: unknown; translationMatches?: unknown; questionsOk?: unknown; problems?: unknown } | null;
      const problems = Array.isArray(v?.problems) ? v!.problems.filter((p): p is string => typeof p === 'string') : [];
      if (v?.natural !== true || v?.translationMatches !== true || v?.questionsOk !== true) {
        last = `the review found problems: ${problems.join('; ') || 'no details'}`;
        feedback = `A reviewer found problems in the last version: ${problems.join(' ') || 'it was not natural Japanese.'} Write a new passage that avoids them.`;
        continue;
      }
      review = { model: verdict.model, natural: true, translationMatches: true, problems };
    }
    return {
      status: 'ready',
      tries,
      content: {
        id: opts.ids.next(),
        learnerId: opts.learnerId,
        createdAt: opts.now.toISOString(),
        source: 'generated',
        promptVersion: READING_PROMPT_VERSION,
        model: result.model,
        title: out.title.trim(),
        text,
        translation: out.translation.trim(),
        tokens: mapped.tokens,
        items: mapped.items,
        targets: targets.map((t) => t.id),
        coverage: check.coverage,
        questions,
        ...(review ? { review } : {}),
      },
    };
  }
  return { status: 'failed', reason: last, tries: cfg.retries + 1 };
}

/** A pre-written passage shipped with the app, for when there is no model: no key, no network, or a failed run. */
export interface LibraryPassage {
  id: string;
  /** Rough difficulty, 1 (first weeks) to 6 (around N4). Only used to break ties. */
  level: number;
  title: string;
  text: string;
  translation: string;
  /** Questions in the model's reply shape; `word` names the passage word a question hinges on (dictionary form). */
  questions?: { question: string; options: string[]; answer: number; word: string }[];
}

export const LIBRARY_PROMPT_VERSION = 'library-2';
export const libraryContentId = (p: LibraryPassage) => `library:${p.id}`;

/** How far a passage is from the sweet spot of about two new words: enough to learn from, few enough to read. */
const stretch = (newWords: number) => Math.abs(newWords - 2);

/**
 * The library passage that fits the learner best right now: enough met words to read it, and closest to two new
 * words. As the learner's words grow, harder passages become the best fit. Tokenizing and mapping run locally.
 */
export async function pickLibraryPassage(
  ports: { tokenizer: Tokenizer; dictionary: Dictionary },
  model: LearnerModel,
  library: LibraryPassage[],
  opts: { learnerId: string; now: Date },
  cache: Map<string, { tokens: ContentToken[]; items: Item[] }> = new Map(),
): Promise<ReadingOutcome> {
  const cfg = model.config.reading;
  const fresh = library.filter((p) => !model.contents.has(libraryContentId(p)));
  if (fresh.length === 0) return { status: 'skipped', reason: 'every library passage has been read' };
  let best: { p: LibraryPassage; mapped: { tokens: ContentToken[]; items: Item[] }; check: PassageCheck } | null = null;
  for (const p of fresh) {
    let mapped = cache.get(p.id);
    if (!mapped) {
      mapped = await mapTokens(await ports.tokenizer.analyze(p.text), ports.dictionary, model.catalog);
      cache.set(p.id, mapped);
    }
    const check = checkPassage(model, p.text, mapped.tokens, [], model.config);
    if (check.coverage < cfg.libraryCoverage || check.newWords.length > cfg.maxNewWords + 2) continue;
    const better =
      !best ||
      stretch(check.newWords.length) < stretch(best.check.newWords.length) ||
      (stretch(check.newWords.length) === stretch(best.check.newWords.length) &&
        (check.coverage > best.check.coverage || (check.coverage === best.check.coverage && p.level < best.p.level)));
    if (better) best = { p, mapped, check };
  }
  if (!best) return { status: 'skipped', reason: 'no library passage fits yet' };
  return {
    status: 'ready',
    tries: 0,
    content: {
      id: libraryContentId(best.p),
      learnerId: opts.learnerId,
      createdAt: opts.now.toISOString(),
      source: 'library',
      promptVersion: LIBRARY_PROMPT_VERSION,
      model: 'none',
      title: best.p.title,
      text: best.p.text,
      translation: best.p.translation,
      tokens: best.mapped.tokens,
      items: best.mapped.items,
      targets: [],
      coverage: best.check.coverage,
      questions: parseQuestions(best.p.questions ?? [], best.mapped.items),
    },
  };
}
