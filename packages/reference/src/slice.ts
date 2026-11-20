// Pure helpers behind scripts/slice.ts, kept apart so they can be tested without the database.

/** Grammar rather than vocabulary: taught through grammar points (step 2), not drilled as words. */
const FUNCTION = new Set(['prt', 'aux', 'aux-v', 'aux-adj', 'cop']);
const AFFIX = new Set(['conj', 'suf', 'pref']);

/** True when the first sense is a particle, auxiliary or copula, or only a conjunction or affix. */
export function isFunctionWord(pos: string[]): boolean {
  return pos.some((p) => FUNCTION.has(p)) || (pos.length > 0 && pos.every((p) => AFFIX.has(p)));
}

/** A reading made of kana only. Rules out iteration marks (ゝ, ヽ) and other symbols listed as entries. */
export function isWordReading(reading: string): boolean {
  return /^[ぁ-ゖァ-ヺー]+$/.test(reading) && !/^ー/.test(reading);
}

/**
 * JMdict part of speech to the engine's inflection classes. Only classes the engine conjugates correctly are
 * mapped; anything else (v5aru, vs-s, suru nouns, archaic verbs) gets none, so inflected answers are not accepted
 * for it rather than being judged against wrong forms.
 */
export function enginePos(pos: string[]): string | undefined {
  for (const p of pos) {
    if (p === 'v1' || p === 'v1-s') return 'v1';
    if (p === 'v5k-s') return 'v5-iku';
    if (p === 'v5r-i') return 'v5-aru';
    if (/^v5[ukgstnbmr]$/.test(p)) return 'v5';
    if (p === 'vk') return 'vk';
    if (p === 'vs-i') return 'vs';
    if (p === 'adj-ix') return 'adj-ii';
    if (p === 'adj-i') return 'adj-i';
    if (p === 'adj-na') return 'adj-na';
  }
  return undefined;
}

/** One accepted English answer per gloss, from the per-sense strings ("at; in; on"), at most eight. */
export function engineGloss(senses: string[]): string[] {
  const out: string[] = [];
  for (const s of senses) for (const g of s.split(/;\s*/)) if (g && !out.includes(g)) out.push(g);
  return out.slice(0, 8);
}

export interface Candidate {
  id: number;
  rank: number | null;
  priority: string;
  primaryForm: number;
}

/** The entry a starter word means: ranked first, then marked common in JMdict, then the primary form, then lowest id. */
export function pickEntry(cands: Candidate[]): number | undefined {
  const score = (c: Candidate) => [c.rank ?? Number.MAX_SAFE_INTEGER, c.priority ? 0 : 1, c.primaryForm ? 0 : 1, c.id];
  return [...cands].sort((a, b) => {
    const x = score(a);
    const y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return 0;
  })[0]?.id;
}
