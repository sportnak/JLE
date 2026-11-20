import { describe, expect, it } from 'vitest';
import {
  assignFrequency, candidateFor, isCommon, isRankable, zipfOfBin, type FormCandidate, type HeadwordInfo,
} from '../src/frequency.ts';

// A tiny dictionary: id, written, reading, kanaOnly, kana forms (text, pri), kanji forms (text, pri), senses (pos, uk).
interface Fx {
  id: number; written: string; reading: string; kanaOnly?: boolean;
  kana: [string, string[]][]; kanji?: [string, string[]][]; pos: string[][]; uk?: boolean;
}
const fx = (id: number, written: string, reading: string, kana: [string, string[]][], kanji: [string, string[]][],
  pos: string[][], opts: { kanaOnly?: boolean; uk?: boolean } = {}): Fx => ({ id, written, reading, kana, kanji, pos, ...opts });

const DICT: Fx[] = [
  fx(10, '野', 'の', [['の', ['ichi1']]], [['野', ['ichi1']]], [['n']]),
  fx(20, 'の', 'の', [['の', ['spec1']]], [], [['prt']]),
  fx(30, '要る', 'いる', [['いる', ['spec1', 'nf27']]], [['要る', []]], [['v5r']], { kanaOnly: true, uk: true }),
  fx(40, '居る', 'いる', [['いる', ['ichi1']]], [['居る', []]], [['v1'], ['aux-v', 'v1']], { kanaOnly: true, uk: true }),
  fx(50, '鴇', 'とき', [['とき', []]], [['鴇', []]], [['n']], { kanaOnly: true, uk: true }),
  fx(60, '時', 'とき', [['とき', ['ichi1']]], [['時', ['ichi1']]], [['n'], ['n']]),
  fx(65, 'とき', 'とき', [['とき', []]], [], [['exp']]),
  fx(70, '人', 'じん', [['じん', ['ichi1']]], [['人', ['ichi1']]], [['suf']]),
  fx(80, '人', 'ひと', [['ひと', ['ichi1']]], [['人', ['ichi1']]], [['n'], ['n'], ['n']]),
  fx(90, '出来', 'でき', [['でき', ['ichi1']]], [['出来', ['ichi1']]], [['n']]),
  fx(91, '出来る', 'できる', [['できる', ['ichi1']]], [['出来る', ['ichi1']]], [['v1']], { kanaOnly: true, uk: true }),
  fx(95, '橋', 'はし', [['はし', ['ichi1']]], [['橋', ['ichi1']]], [['n']]),
  fx(96, '箸', 'はし', [['はし', ['ichi1']]], [['箸', ['ichi1']]], [['n']]),
  // A common second reading (皆 みな / みんな), on an entry with a 'uk' sense.
  fx(100, '皆', 'みな', [['みな', ['ichi1']], ['みんな', ['ichi1']]], [['皆', ['ichi1']]], [['n'], ['adv']], { uk: true }),
  // A common reading that as a MeCab token is an inflection piece (ており → おり), not 折.
  fx(110, '折', 'おり', [['おり', ['ichi1']]], [['折', ['ichi1']]], [['n']]),
  // Homographs where newspaper tags sit on the rarer one: 下 もと news1 vs 下 した ichi1.
  fx(120, '下', 'した', [['した', ['ichi1']]], [['下', ['ichi1']]], [['n'], ['n'], ['n']]),
  fx(121, '下', 'もと', [['もと', ['news1', 'nf07']]], [['下', ['news1', 'nf07']]], [['n']]),
  fx(130, '増し', 'まし', [['まし', ['ichi1']]], [['増し', ['ichi1']]], [['adj-na']], { kanaOnly: true, uk: true }),
  fx(131, 'ます', 'ます', [['ます', []]], [], [['aux-v']]),
  fx(140, '々', '々', [['々', []]], [], [['unc']]),
  fx(150, 'ド', 'ド', [['ド', []]], [], [['n']]),
  fx(160, '烏賊', 'いか', [['いか', ['ichi1']], ['イカ', ['spec1']]], [['烏賊', ['ichi1']]], [['n']], { uk: true }),
  fx(1308080, '市', 'いち', [['いち', ['ichi1']]], [['市', ['ichi1']]], [['n']]),
  fx(1308090, '市', 'し', [['し', ['ichi1']]], [['市', ['ichi1']]], [['n']]),
];

function lookupOf(dict: Fx[]) {
  const map = new Map<string, FormCandidate[]>();
  for (const e of dict) {
    const info: HeadwordInfo = {
      written: e.written, reading: e.reading, kanaOnly: e.kanaOnly ?? e.kanji!.length === 0,
      hasKanji: e.kanji!.length > 0, readingPri: e.kana[0]![1],
      commonKana: e.kana.filter(([, p]) => isCommon(p)).map(([t]) => t),
      func: e.pos.some((p) => p.some((x) => ['prt', 'aux-v', 'aux', 'cop', 'conj'].includes(x))),
      ukSense: e.uk ?? false,
    };
    for (const [text, pri] of [...e.kanji!, ...e.kana]) {
      const list = map.get(text) ?? [];
      list.push(candidateFor(e.id, text, info, pri, e.pos));
      map.set(text, list);
    }
  }
  return (k: string) => map.get(k);
}

const rank = (bins: string[][]) => assignFrequency(bins, lookupOf(DICT));

describe('assignFrequency', () => {
  it('gives a kana token to the entry it is the headword of, not a kanji word read that way', () => {
    expect(rank([['の']]).get(20)?.rank).toBe(1);
    expect(rank([['の']]).has(10)).toBe(false);
  });

  it('prefers a function-word sense among common kana-only homographs', () => {
    const r = rank([['いる']]);
    expect([...r.keys()]).toEqual([40]);
  });

  it('does not let a rare usually-kana noun, or an untagged kana word, take a common kana word', () => {
    // 鴇 とき and the kanji-less とき are untagged; 時 has とき ichi1 but no 'uk' sense, so the
    // hiragana token is too ambiguous to give anyone.
    expect(rank([['とき']]).size).toBe(0);
    expect(rank([['時']]).get(60)?.rank).toBe(1);
  });

  it('counts a common second kana spelling when the entry is usually written in kana', () => {
    expect([...rank([['みんな']]).keys()]).toEqual([100]);
  });

  it('ignores a common hiragana reading of an ordinary kanji word (inflection pieces)', () => {
    expect(rank([['おり']]).size).toBe(0);
    expect(rank([['折']]).get(110)?.rank).toBe(1);
  });

  it('counts a katakana spelling of a kanji word marked uk', () => {
    expect([...rank([['イカ']]).keys()]).toEqual([160]);
  });

  it('prefers ichi1 over newspaper-only tags on a shared kanji spelling', () => {
    expect([...rank([['下']]).keys()]).toEqual([120]);
  });

  it('folds inflection pieces into their word, or drops them', () => {
    // まし (from ました) is not 増し; it folds into ます.
    expect([...rank([['まし']]).keys()]).toEqual([131]);
    // でき folds into 出来る instead of ranking the noun 出来; the kanji stem 出来 does too.
    expect([...rank([['でき']]).keys()]).toEqual([91]);
    expect([...rank([['出来']]).keys()]).toEqual([91]);
  });

  it('applies hand-reviewed homograph overrides', () => {
    expect([...rank([['市']]).keys()]).toEqual([1308090]);
  });

  it('skips iteration marks and lone kana that are not particles or auxiliaries', () => {
    expect(isRankable('々')).toBe(false);
    expect(rank([['々'], ['ド']]).size).toBe(0);
  });

  it('breaks kanji homograph ties by sense count, then lowest id', () => {
    expect([...rank([['人']]).keys()]).toEqual([80]);
    expect([...rank([['橋'], ['はし']]).keys()]).toEqual([95]);
  });

  it('keeps an entry at its best rank and keeps ranks dense', () => {
    const r = rank([['時'], ['の', '時'], ['橋', 'の'], ['居る']]);
    expect(r.get(60)).toEqual({ rank: 1, zipf: 9 });
    expect(r.get(20)).toEqual({ rank: 2, zipf: 8.99 });
    expect(r.get(95)).toEqual({ rank: 3, zipf: 8.98 });
    expect(r.get(40)).toEqual({ rank: 4, zipf: 8.97 });
    expect([...r.values()].map((x) => x.rank).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('does not fall through to a weaker homograph once the best one is ranked', () => {
    const r = rank([['人'], ['人']]);
    expect([...r.keys()]).toEqual([80]);
  });

  it('skips ASCII, numbers and punctuation', () => {
    expect(isRankable('the')).toBe(false);
    expect(isRankable('2024')).toBe(false);
    expect(isRankable('、')).toBe(false);
    expect(isRankable('tシャツ')).toBe(true);
    expect(rank([['the', '2024', '時']]).get(60)?.rank).toBe(1);
  });

  it('derives Zipf from the centibel bin', () => {
    expect(zipfOfBin(0)).toBe(9);
    expect(zipfOfBin(128)).toBe(7.72);
  });
});
