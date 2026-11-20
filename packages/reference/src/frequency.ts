// Assigns wordfreq ranks to JMdict entries. Pure, so it can be tested without the downloaded data.

/** One entry form that a wordfreq token can match. */
export interface FormCandidate {
  entryId: number;
  /**
   * How strongly the token names this entry (see headwordTier): 2 = its headword, 1 = a common
   * kana spelling of it, 0 = merely a form it lists. A pure-kana token needs at least 1.
   */
  tier: number;
  /** Some sense is a particle, auxiliary, copula or conjunction. */
  func: boolean;
  /** The matched form carries ichi1, news1, spec1 or gai1. */
  common: boolean;
  /** The matched form carries ichi1 (the Ichimango word list, assigned per word). */
  ichi1: boolean;
  senses: number;
}

export interface Ranked {
  rank: number;
  zipf: number;
}

const FUNC_POS = new Set(['prt', 'aux', 'aux-v', 'aux-adj', 'cop', 'conj']);
const COMMON = new Set(['ichi1', 'news1', 'spec1', 'gai1']);
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const KANA = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;
const KATAKANA = /^[\p{Script=Katakana}ー]+$/u;
/** Iteration marks: JMdict lists them as entries, but they are not words. */
const ITERATION_MARKS = /^[々〆〻ゝゞヽヾ〃]+$/u;

/**
 * MeCab splits inflected verbs and auxiliaries into surface pieces (ました → まし + た). Pieces
 * that spell an unrelated dictionary word are folded into the word they come from, or dropped
 * (null) when that word is already counted by its own token. Keys are wordfreq tokens; only
 * frequent pieces that were seen landing on the wrong entry are listed. Reviewed by hand.
 */
export const TOKEN_FOLDS: Readonly<Record<string, string | null>> = {
  まし: 'ます', ませ: 'ます', でし: 'です', だろ: 'だろう', でしょ: 'でしょう', ましょ: 'ます',
  でき: '出来る', あり: '有る', いけ: null, みえ: '見える', かっ: null, とっ: null, いっ: null,
  なっ: null, あっ: null, やっ: null, しよ: null, ござい: 'ござる', くれ: '呉れる', なく: null,
  つけ: null, かけ: null, あたり: '辺り',
  // Kanji stems MeCab cuts off verbs (見て → 見 + て), which otherwise rank a noun of that spelling.
  見: '見る', 出来: '出来る', 入れ: '入れる', 出し: '出す', 受け: '受ける',
  き: null, じ: null, せ: null, ろ: null,
};

/**
 * Spellings shared by several entries whose priority tags tie (or mislead), mapped to the entry
 * that the bare token almost always means in running text. Reviewed by hand.
 */
export const HOMOGRAPH_OVERRIDES: Readonly<Record<string, number>> = {
  お: 2826528, // 御 honorific prefix (a lone kana otherwise only ranks particles and auxiliaries)
  ご: 1270190, // 御 honorific prefix
  実: 1320800, // じつ (実は), not み fruit
  共: 1578040, // とも (共に), not the suffix ども
  市: 1308090, // し city, not いち market
  心: 1360480, // こころ, not しん
  金: 1242590, // かね money, not きん gold
  風: 1499720, // かぜ wind, not ふう style
  未: 2242840, // み not yet, not ひつじ (zodiac)
  位: 2068010, // い rank (第1位), not くらい throne
  館: 1929870, // かん hall, not やかた
  官: 1983700, // かん, not つかさ
  下手: 1185200, // へた unskilful, not したて
  数: 1580820, // かず number, not すう several
  角: 1206110, // かど corner, not かく angle
};

/** The key forms and tokens are matched on: wordfreq stores NFKC, lower-cased text. */
export const matchKey = (text: string): string => text.normalize('NFKC').toLowerCase();

/** Tokens with no kana or kanji (ASCII, punctuation, numbers), and iteration marks, are not words to rank. */
export const isRankable = (token: string): boolean => JAPANESE.test(token) && !ITERATION_MARKS.test(token);

export const isFunctionPos = (pos: readonly string[]): boolean => pos.some((p) => FUNC_POS.has(p));

export const isCommon = (pri: readonly string[]): boolean => pri.some((p) => COMMON.has(p));

export interface HeadwordInfo {
  written: string;
  reading: string;
  kanaOnly: boolean;
  hasKanji: boolean;
  readingPri: readonly string[];
  /** Every kana form of the entry that carries a common tag. */
  commonKana: readonly string[];
  /** Some sense is a function word. */
  func: boolean;
  /** Some sense is marked 'uk' (usually written in kana). */
  ukSense: boolean;
}

/**
 * How strongly a spelling names an entry.
 * 2: the entry's written form; or the reading of a kana-only entry when the entry has kanji and
 *    that reading is marked common ('uk' on a rare noun like 鴇 とき says how to write it, not
 *    what the kana usually means), or has no kanji and is tagged common or is a function word.
 * 1: another kana spelling marked common, when the entry has no kanji (でしょう でしょ), some
 *    sense is 'uk' (皆 みんな, 一杯 いっぱい, 所 ところ), or the spelling is katakana (烏賊 イカ);
 *    also the reading of an untagged kanji-less entry, which then yields to a tagged one (とき).
 *    Hiragana spellings of ordinary kanji words are left out: as MeCab tokens they are nearly
 *    always inflection pieces (おり, やり, いき, しろ) rather than the word (折, 槍, 粋, 白).
 * 0: anything else.
 */
export function headwordTier(e: HeadwordInfo, text: string): number {
  const key = matchKey(text);
  const is = (s: string) => matchKey(s) === key;
  if (is(e.written)) {
    if (e.hasKanji) return 2;
    return isCommon(e.readingPri) || e.func ? 2 : 1;
  }
  if (e.kanaOnly && is(e.reading) && isCommon(e.readingPri)) return 2;
  if (!e.commonKana.some(is)) return 0;
  return !e.hasKanji || e.ukSense || KATAKANA.test(text) ? 1 : 0;
}

export function candidateFor(
  entryId: number, formText: string, info: HeadwordInfo, pri: readonly string[],
  sensePos: readonly (readonly string[])[],
): FormCandidate {
  return {
    entryId,
    tier: headwordTier(info, formText),
    func: sensePos.some(isFunctionPos),
    common: isCommon(pri),
    ichi1: pri.includes('ichi1'),
    senses: sensePos.length,
  };
}

/**
 * Negative when a beats b. Order: tier; any common tag (so the untagged particle こと does not
 * take 事's こと); a function-word sense (いる → 居る over 要る, なる → 成る over 生る); ichi1;
 * more senses; lowest ent_seq.
 *
 * news1/news2 and nfXX are not used past the yes/no: they come from counting a string in
 * newspapers, and on a shared spelling they often sit on the rarer homograph (下 もと has
 * news1,nf07 and 下 した only ichi1; 空 から has nf03, 空 そら none; 生る なる nf07, 成る nf34).
 * ichi1 comes from a word list, so it is a fairer signal. Ties that remain wrong go in
 * HOMOGRAPH_OVERRIDES.
 */
export function compareCandidates(a: FormCandidate, b: FormCandidate): number {
  return (
    b.tier - a.tier ||
    Number(b.common) - Number(a.common) ||
    Number(b.func) - Number(a.func) ||
    Number(b.ichi1) - Number(a.ichi1) ||
    b.senses - a.senses ||
    a.entryId - b.entryId
  );
}

/** wordfreq's cB packs: bin i holds words at -i centibels, so Zipf = 9 - i/100. */
export const zipfOfBin = (bin: number): number => (900 - bin) / 100;

export const isKana = (token: string): boolean => KANA.test(token);

/** Picks the entry a token names, or undefined. Exported for tests and diagnostics. */
export function pickEntry(
  token: string, lookup: (key: string) => readonly FormCandidate[] | undefined,
): number | undefined {
  if (!isRankable(token)) return undefined;
  let key = matchKey(token);
  if (key in TOKEN_FOLDS) {
    const to = TOKEN_FOLDS[key];
    if (to == null) return undefined;
    key = matchKey(to);
  }
  let cands = lookup(key) ?? [];
  const override = HOMOGRAPH_OVERRIDES[key];
  if (override !== undefined && cands.some((c) => c.entryId === override)) return override;
  if (isKana(key)) {
    cands = cands.filter((c) => c.tier > 0);
    // A lone kana is a particle or auxiliary, or a fragment of a longer word (お and ご are overrides).
    if ([...key].length === 1) cands = cands.filter((c) => c.func);
  }
  if (cands.length === 0) return undefined;
  let best = cands[0]!;
  for (const c of cands) if (compareCandidates(c, best) < 0) best = c;
  // An untagged content word does not take a spelling that a commonly tagged entry also has
  // (the kanji-less 'please do' とき vs 時 とき): the token most likely means the other word.
  // Particles and auxiliaries are exempt: JMdict leaves many untagged (て, た, ます).
  if (!best.common && !best.func && (lookup(key) ?? []).some((c) => c.common)) return undefined;
  return best.entryId;
}

/**
 * Walks tokens in wordfreq order. Each token picks its single best entry; that entry takes the
 * next dense rank unless it already has one (an entry keeps its best rank, and the token does
 * not fall through to a weaker homograph). A kana token only ranks an entry it is a headword or
 * common kana spelling of: wordfreq's tokens are MeCab surfaces, so kana that spell a kanji word's
 * rare reading are mostly inflection stems (でき, くれ, なく) or other words.
 */
export function assignFrequency(
  bins: readonly (readonly string[])[],
  lookup: (key: string) => readonly FormCandidate[] | undefined,
  onRank?: (token: string, entryId: number, r: Ranked) => void,
): Map<number, Ranked> {
  const ranked = new Map<number, Ranked>();
  let next = 1;
  bins.forEach((words, bin) => {
    for (const token of words) {
      const id = pickEntry(token, lookup);
      if (id === undefined || ranked.has(id)) continue;
      const r = { rank: next++, zipf: zipfOfBin(bin) };
      ranked.set(id, r);
      onRank?.(token, id, r);
    }
  });
  return ranked;
}
