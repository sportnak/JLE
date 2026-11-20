import type { EngineConfig } from '../config';
import type { LearnerModel } from '../learner';
import type { Dictionary, DictionaryEntry, Ids, Llm, LlmRequest, Token, Tokenizer } from '../ports';
import type { Catalog, ContentToken, Item, StoredContent } from '../types';

export const READING_PROMPT_VERSION = 'reading-1';

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
- translation: a natural English translation of the passage`;

export const READING_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    text: { type: 'string' },
    translation: { type: 'string' },
  },
  required: ['title', 'text', 'translation'],
  additionalProperties: false,
};

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

/**
 * Maps tracked tokens to items through the host's dictionary. Words it cannot find stay untracked. Every item it maps
 * to is returned, so stored content replays the same even if the built-in word list changes later.
 */
export async function mapTokens(
  tokens: Token[],
  dictionary: Dictionary,
  catalog: Catalog,
): Promise<{ tokens: ContentToken[]; items: Item[] }> {
  const tracked = tokens.map((t, i) => [t, i] as const).filter(([t]) => isTracked(t));
  const found = await dictionary.lookup(tracked.map(([t]) => ({ lemma: t.dictionaryForm, reading: t.dictionaryReading })));
  const itemAt = new Map<number, Item>();
  const items = new Map<string, Item>();
  tracked.forEach(([, i], k) => {
    const entry = found[k];
    if (!entry) return;
    const item = catalog.item(`jmdict:${entry.id}`) ?? itemFromEntry(entry);
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
    const out = result.output as { title?: unknown; text?: unknown; translation?: unknown } | null;
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
      },
    };
  }
  return { status: 'failed', reason: last, tries: cfg.retries + 1 };
}
