import type { Pos } from '@jle/engine';
import data from './data/words.json';

/** A word from the dictionary slice. Starter words come first, in their hand-made order, then by frequency. */
export interface WordRow {
  jmdictId: number;
  written: string;
  reading: string;
  /** Rank in the frequency list, 1 = most frequent; 0 when unranked. */
  freqRank: number;
  gloss: string[];
  pos?: Pos;
}

type Raw = [number, string, string, number, string[], string?];
const file = data as unknown as { starterCount: number; aliases: Record<string, string>; words: Raw[]; attribution: string };

export const WORDS: WordRow[] = file.words.map(([jmdictId, written, reading, freqRank, gloss, pos]) => ({
  jmdictId,
  written,
  reading,
  freqRank,
  gloss,
  ...(pos ? { pos: pos as Pos } : {}),
}));

/** How many rows at the start are the starter list. */
export const STARTER_COUNT = file.starterCount;
/** Starter ids (`vocab:<written>`) to dictionary ids, for logs written before the switch. */
export const STARTER_ALIASES: Record<string, string> = file.aliases;
export const ATTRIBUTION = file.attribution;

export const wordId = (jmdictId: number) => `jmdict:${jmdictId}`;
