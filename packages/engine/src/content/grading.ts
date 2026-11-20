import { grammarItemId } from '../catalog';
import type { Dictionary, LlmRequest, Tokenizer } from '../ports';
import { ERROR_TYPES, type Catalog, type ErrorType, type Finding, type GrammarPoint, type Item, type RawFinding, type StoredGrade } from '../types';
import { mapTokens } from './reading';

export const GRADE_PROMPT_VERSION = 'grade-1';

const ERROR_MEANINGS: Record<ErrorType, string> = {
  particle: 'a wrong, missing or extra particle (は, が, を, に, で, と, も, の, へ, から, まで …)',
  conjugation: 'a wrong form of a verb, adjective or です (tense, polite or plain, negative, て-form …)',
  word_choice: 'a real word used where another word is needed',
  spelling: 'a word written wrongly: wrong kana or kanji, or a misspelled reading',
  word_order: 'words in an order Japanese does not allow',
  politeness: 'mixed or wrong politeness for the task',
  missing_word: 'a needed word left out (not a particle)',
  extra_word: 'a word that should not be there (not a particle)',
  other: 'any other error',
};

/**
 * Route `grade` (architecture §6.3, §7.1). The system text, with the approved grammar list appended, is stable and
 * cached (§7.2): it carries no learner state. The task, the target words and the answer go in the user message. The
 * known-word list is never sent.
 */
export const GRADE_SYSTEM = `You grade short pieces of Japanese written by someone learning Japanese, and report each error you find.

Error types (use exactly one per finding):
${ERROR_TYPES.map((t) => `- ${t}: ${ERROR_MEANINGS[t]}`).join('\n')}

Rules:
- quote: copy the wrong text exactly as it appears in the learner's answer, character for character, as short as possible while still holding the error. Never quote text that is not in the answer.
- Something missing (a particle or a word): quote the word just before the gap, and give that word with the missing part added as the correction (学校 → 学校に). If the gap is at the very start, quote the word just after it.
- correction: what the quoted text should be. Replacing the quote with the correction must fix the error.
- lemma: the dictionary form of the word the error is about (食べる, not 食べた), or null when the error is not about one word.
- grammarPoint: an id from the grammar list you are given, only when the error is about that point; otherwise null. Never invent an id.
- explanation: one or two plain English sentences a beginner can follow. No romaji.
- confidence: high when you are sure it is an error, medium when it is probably an error, low when it is doubtful. Be honest.
- Mark only errors. A choice that is correct but not the one you would make is a stylistic preference, not an error. Do not mark it.
- When the answer is correct, return an empty findings list.
- corrected: the whole answer with every correction applied and nothing else changed.
- targetsUsed: the target words, written exactly as in the list, that the answer uses correctly.
- comment: one or two short, kind sentences in English about the answer.`;

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

export const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string' },
          lemma: nullableString,
          grammarPoint: nullableString,
          errorType: { type: 'string', enum: [...ERROR_TYPES] },
          correction: { type: 'string' },
          explanation: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['quote', 'lemma', 'grammarPoint', 'errorType', 'correction', 'explanation', 'confidence'],
        additionalProperties: false,
      },
    },
    corrected: { type: 'string' },
    targetsUsed: { type: 'array', items: { type: 'string' } },
    comment: { type: 'string' },
  },
  required: ['findings', 'corrected', 'targetsUsed', 'comment'],
  additionalProperties: false,
};

/** The cached system text: the rules, then the approved grammar points (id and label only). */
export function gradeSystem(grammar: GrammarPoint[]): string {
  return `${GRADE_SYSTEM}\n\nGrammar points (id: label):\n${grammar.length ? grammar.map((p) => `- ${p.id}: ${p.label}`).join('\n') : '(none)'}`;
}

/** The grading request: the approved grammar in the cached system text; the task, target words and answer after it. */
export function gradeRequest(task: string, targets: Item[], answer: string, grammar: GrammarPoint[], sessionId?: string): LlmRequest {
  const lines = [
    `Task: ${task}`,
    `Target words:\n${targets.length ? targets.map((t) => `- ${t.written} (${t.reading}): ${t.gloss[0] ?? ''}`).join('\n') : '(none)'}`,
    `The learner's answer:\n${answer}`,
  ];
  return {
    promptVersion: GRADE_PROMPT_VERSION,
    system: gradeSystem(grammar),
    user: lines.join('\n\n'),
    schema: GRADE_SCHEMA,
    maxTokens: 8000,
    effort: 'medium',
    ...(sessionId ? { sessionId } : {}),
  };
}

export type MappedGrade = Pick<StoredGrade, 'corrected' | 'targetsUsed' | 'usedItems' | 'findings' | 'comment'>;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const CONFIDENCE = new Set(['high', 'medium', 'low']);

/** The model's findings, checked field by field. A finding with no quote cannot be placed, so it is dropped. */
export function parseFindings(raw: unknown, grammar: GrammarPoint[]): RawFinding[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set(grammar.map((p) => p.id));
  return raw.flatMap((f): RawFinding[] => {
    if (!f || typeof f !== 'object') return [];
    const r = f as Record<string, unknown>;
    const quote = str(r.quote).trim();
    if (!quote) return [];
    const lemma = str(r.lemma).trim();
    const point = str(r.grammarPoint).trim();
    return [
      {
        quote,
        lemma: lemma || null,
        grammarPoint: ids.has(point) ? point : null,
        errorType: (ERROR_TYPES as readonly string[]).includes(str(r.errorType)) ? (r.errorType as ErrorType) : 'other',
        correction: str(r.correction).trim(),
        explanation: str(r.explanation).trim(),
        confidence: CONFIDENCE.has(str(r.confidence)) ? (r.confidence as RawFinding['confidence']) : 'low',
      },
    ];
  });
}

/** Sentences of a text as code-point spans, each ending after 。！？ (or at the end of the text). */
export function sentenceSpans(text: string): { begin: number; end: number }[] {
  const chars = [...text];
  const out: { begin: number; end: number }[] = [];
  let begin = 0;
  chars.forEach((c, i) => {
    if ('。！？!?\n'.includes(c)) {
      out.push({ begin, end: i + 1 });
      begin = i + 1;
    }
  });
  if (begin < chars.length) out.push({ begin, end: chars.length });
  return out;
}

/** The sentence holding a code-point offset. */
export function sentenceAt(text: string, at: number): { begin: number; end: number; text: string } | null {
  const s = sentenceSpans(text).find((x) => at >= x.begin && at < x.end);
  return s ? { ...s, text: [...text].slice(s.begin, s.end).join('') } : null;
}

/** Code-point span of a quote, skipping occurrences already claimed by an earlier finding with the same quote. */
function spanOf(answer: string, quote: string, taken: { begin: number; end: number }[]): { begin: number; end: number } | null {
  const len = [...quote].length;
  for (let from = answer.indexOf(quote); from >= 0; from = answer.indexOf(quote, from + 1)) {
    const begin = [...answer.slice(0, from)].length;
    const end = begin + len;
    if (!taken.some((t) => t.begin === begin && t.end === end)) return { begin, end };
  }
  return null;
}

/**
 * The sentence holding `f` with every other finding in it corrected (right to left, skipping overlaps), so it shows
 * exactly this one error, in the learner's own words.
 */
export function singleErrorSentence(answer: string, f: Pick<Finding, 'begin' | 'end'>, all: Pick<Finding, 'begin' | 'end' | 'correction'>[]): string | null {
  if (f.begin === null || f.end === null) return null;
  const s = sentenceAt(answer, f.begin);
  if (!s) return null;
  const chars = [...answer];
  const overlaps = (a: { begin: number; end: number }, b: { begin: number; end: number }) => a.begin < b.end && b.begin < a.end;
  const others = all
    .filter((o): o is typeof o & { begin: number; end: number } => o !== f && o.begin !== null && o.end !== null)
    .filter((o) => o.begin >= s.begin && o.end <= s.end && !overlaps(o, { begin: f.begin!, end: f.end! }))
    .sort((a, b) => b.begin - a.begin);
  let applied: { begin: number; end: number }[] = [];
  let out = chars.slice(s.begin, s.end);
  for (const o of others) {
    if (applied.some((a) => overlaps(a, o))) continue;
    out = [...out.slice(0, o.begin - s.begin), ...o.correction, ...out.slice(o.end - s.begin)];
    applied = [...applied, o];
  }
  return out.join('');
}

/**
 * Maps the grader's reply onto items in code (architecture §6.3): spans from quotes, grammar points through the approved
 * list, words through the tokenizer and dictionary. The model never gives ids. A finding that cannot be mapped is kept
 * without `itemId` and gives no evidence. Only items the catalog holds are used, so replay finds the same items.
 */
export async function mapGrade(
  raw: unknown,
  input: { answer: string; targets: Item[] },
  ports: { tokenizer: Tokenizer; dictionary: Dictionary },
  catalog: Catalog,
): Promise<MappedGrade> {
  const out = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const grammar = catalog.grammar();
  const { answer } = input;
  const mapped = await mapTokens(await ports.tokenizer.analyze(answer), ports.dictionary, catalog);
  const known = (id: string | undefined) => {
    const r = id && catalog.resolve(id);
    return r && catalog.item(r) ? r : undefined;
  };
  const tokens = mapped.tokens.map((t) => ({ ...t, itemId: known(t.itemId) }));
  const taken: { begin: number; end: number }[] = [];
  const findings: Finding[] = parseFindings(out.findings, grammar).map((f) => {
    const span = spanOf(answer, f.quote, taken);
    if (span) taken.push(span);
    const finding: Finding = { ...f, begin: span?.begin ?? null, end: span?.end ?? null };
    const itemId = findingItem(f, span, tokens, catalog);
    return itemId ? { ...finding, itemId } : finding;
  });
  for (const f of findings) {
    const s = singleErrorSentence(answer, f, findings);
    if (s !== null) f.singleErrorSentence = s;
  }
  const targetsUsed = Array.isArray(out.targetsUsed)
    ? [...new Set(out.targetsUsed.flatMap((w) => input.targets.filter((t) => typeof w === 'string' && (t.written === w.trim() || t.reading === w.trim())).map((t) => t.id)))]
    : [];
  return {
    corrected: str(out.corrected).trim() || answer,
    targetsUsed,
    usedItems: [...new Set(tokens.flatMap((t) => (t.itemId ? [t.itemId] : [])))],
    findings,
    comment: str(out.comment).trim(),
  };
}

function findingItem(
  f: RawFinding,
  span: { begin: number; end: number } | null,
  tokens: { begin: number; end: number; lemma?: string; itemId?: string | undefined }[],
  catalog: Catalog,
): string | undefined {
  if (f.grammarPoint) {
    const id = grammarItemId(f.grammarPoint);
    if (catalog.item(id)) return id;
  }
  if (!f.lemma) return undefined;
  const lemma = f.lemma;
  if (span) {
    const over = tokens.filter((t) => t.itemId && t.begin < span.end && span.begin < t.end);
    const same = over.find((t) => {
      const item = catalog.item(t.itemId!);
      return t.lemma === lemma || item?.written === lemma || item?.reading === lemma;
    });
    if (same) return same.itemId;
  }
  // Only the word the lemma names, never a neighbour in the quote: a particle or unknown lemma stays unmapped.
  return catalog.byWritten(lemma).find((i) => i.type === 'vocab')?.id;
}
