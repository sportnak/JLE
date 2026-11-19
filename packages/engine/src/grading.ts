import { toHiragana, toKana } from 'wanakana';
import { inflections } from './conjugate';
import type { Cue, Grade, Item } from './types';

export const GRADER_VERSION = 'grader-rules-1';

export { asHiragana };

export function grade(item: Item, cue: Cue, answer: string): Grade {
  switch (cue) {
    case 'kana_to_reading':
      return gradeKanaReading(item, answer);
    case 'en_to_ja':
      return gradeJapanese(item, answer);
    case 'ja_to_en':
      return gradeEnglish(item, answer);
  }
}

const hira = (s: string) => toHiragana(s, { passRomaji: false, convertLongVowelMark: false });

function asHiragana(text: string): string {
  return hira(toKana(text.trim().toLowerCase())).replace(/[\s　]/g, '');
}

const HOMOPHONES: Record<string, string> = { ぢ: 'じ', づ: 'ず', を: 'お' };
const foldHomophones = (s: string) => s.replace(/[ぢづを]/g, (c) => HOMOPHONES[c] ?? c);

const SMALL_TO_BIG: Record<string, string> = { ゃ: 'や', ゅ: 'ゆ', ょ: 'よ' };

function gradeKanaReading(item: Item, answer: string): Grade {
  const expected = foldHomophones(hira(item.reading));
  const given = asHiragana(answer);
  const correct = answer.trim() !== '' && foldHomophones(given) === expected;
  if (correct || !given) return { correct, expected: item.reading };
  return { correct, expected: item.reading, note: kanaNote(item.reading, given) };
}

/** What a wrong kana answer turned into, in kana, plus why when a combined sound was split in two. */
export function kanaNote(reading: string, given: string): string {
  const typed = `You typed ${given}.`;
  const target = hira(reading);
  const split = target.replace(/[ゃゅょ]/g, (c) => SMALL_TO_BIG[c] ?? c);
  if (split !== target && given === split) {
    return `${typed} That is two sounds. ${reading} is one: the small ${reading.slice(-1)} blends into ${reading.slice(0, -1)}.`;
  }
  return typed;
}

function gradeJapanese(item: Item, answer: string): Grade {
  const raw = answer.trim().replace(/[\s　。]/g, '');
  const expected = expectedJapanese(item);
  if (!raw) return { correct: false, expected };
  const kana = asHiragana(raw);
  if (raw === item.written || kana === hira(item.reading) || kana === hira(item.written)) return { correct: true, expected };
  if (item.pos) {
    const forms = [...inflections(hira(item.reading), item.pos), ...inflections(item.written, item.pos)];
    const hit = forms.find((f) => f.text === raw || hira(f.text) === kana);
    if (hit) return { correct: true, expected, note: `That is the ${hit.label}. The dictionary form is ${expected}.` };
  }
  return { correct: false, expected };
}

function expectedJapanese(item: Item): string {
  return item.written === item.reading ? item.written : `${item.written}（${item.reading}）`;
}

const STOP = /^(to|a|an|the)\s+/;

export function normalizeEnglish(text: string): string {
  return text
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(STOP, '')
    .trim();
}

function gradeEnglish(item: Item, answer: string): Grade {
  const given = normalizeEnglish(answer);
  const expected = item.gloss.join('; ');
  if (!given) return { correct: false, expected };
  const glosses = item.gloss.map(normalizeEnglish);
  const correct = glosses.some((g) => g === given || (g.length > 4 && editDistance(g, given) <= 1));
  return { correct, expected };
}

/** Optimal string alignment distance: edits plus adjacent transpositions. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}
