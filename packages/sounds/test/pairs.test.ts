import { describe, expect, it } from 'vitest';
import { FEATURES, PAIRS, pairId } from '../src/index';

const LONG_VOWEL = /([あいうえおぁぃぅぇぉ]|ー)/;

/** Removes the one feature from the longer word; what is left must be the shorter word. */
function strip(feature: string, word: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]!;
    if (feature === 'sokuon' ? ch === 'っ' || ch === 'ッ' : LONG_VOWEL.test(ch) && i > 0) out.push(word.slice(0, i) + word.slice(i + 1));
  }
  return out;
}

describe('minimal pairs', () => {
  it('has about ten pairs per feature', () => {
    for (const f of FEATURES) expect(PAIRS.filter((p) => p.feature === f.id).length, f.id).toBeGreaterThanOrEqual(10);
  });

  it.each(PAIRS.map((p) => [pairId(p), p] as const))('%s differs only in its feature', (_id, p) => {
    expect(strip(p.feature, p.long[0])).toContain(p.short[0]);
  });

  it('has unique ids and glosses for both words', () => {
    expect(new Set(PAIRS.map(pairId)).size).toBe(PAIRS.length);
    for (const p of PAIRS) expect(p.short[1] && p.long[1]).toBeTruthy();
  });
});
