import type { ContentToken, StoredContent } from '../types';

export interface Sentence {
  begin: number;
  end: number;
  text: string;
  tokens: ContentToken[];
}

const END = /^[。！？!?]+$/;

/** A passage's sentences, split after 。！？, with their tokens. Offsets are characters into the passage. */
export function sentencesOf(content: StoredContent): Sentence[] {
  const chars = [...content.text];
  const out: Sentence[] = [];
  let start = 0;
  let toks: ContentToken[] = [];
  const close = (end: number) => {
    const text = chars.slice(start, end).join('').trim();
    if (text) out.push({ begin: start, end, text: chars.slice(start, end).join(''), tokens: toks });
    toks = [];
    start = end;
  };
  for (const t of content.tokens) {
    toks.push(t);
    if (END.test(t.surface)) close(t.end);
  }
  if (start < chars.length) close(chars.length);
  return out;
}

/** A sentence the learner kept from a passage. */
export interface KeptSentence extends Sentence {
  contentId: string;
  at: string;
}
