import { describe, expect, it } from 'vitest';
import { activityTypes, gradeDictation, gradeMinimalPair, normalizeReading, REGISTRY, type ActivitySpec, type Segment } from '../src/index';

const pair = (answer: string): Extract<ActivitySpec, { type: 'minimal_pair' }> => ({
  type: 'minimal_pair',
  itemId: 'sound:vowel-length',
  purpose: 'probe',
  pairId: 'pair:おばさん/おばあさん',
  options: ['おばあさん', 'おばさん'],
  answer,
});

describe('minimal-pair grading', () => {
  it.each([
    ['おばあさん', 'おばあさん', true],
    ['おばあさん', 'おばさん', false],
    ['おばさん', 'おばさん', true],
    ['おばさん', '', false],
  ] as const)('played %s, chose %s', (played, chose, correct) => {
    expect(gradeMinimalPair(pair(played), chose)).toEqual({ correct, expected: played });
  });
});

const NEKO: Segment[] = [
  { text: '猫', reading: 'ねこ', itemId: 'vocab:猫' },
  { text: 'が', reading: 'が' },
  { text: '好き', reading: 'すき', itemId: 'vocab:好き' },
  { text: 'です', reading: 'です' },
];
const HON: Segment[] = [
  { text: 'これ', reading: 'これ', itemId: 'vocab:これ' },
  { text: 'は', reading: 'わ' },
  { text: '本', reading: 'ほん', itemId: 'vocab:本' },
  { text: 'です', reading: 'です' },
];
const COFFEE: Segment[] = [
  { text: '毎日', reading: 'まいにち', itemId: 'vocab:毎日' },
  { text: 'コーヒー', reading: 'コーヒー', itemId: 'vocab:コーヒー' },
  { text: 'を', reading: 'を' },
  { text: '飲む', reading: 'のむ', itemId: 'vocab:飲む' },
];

describe('dictation grading by reading', () => {
  it.each([
    ['kana', NEKO, 'ねこがすきです', true, [true, true, true, true]],
    ['romaji typed through the IME', NEKO, 'nekogasukidesu', true, [true, true, true, true]],
    ['spaces and a full stop', NEKO, 'ねこ が すき です。', true, [true, true, true, true]],
    ['katakana', NEKO, 'ネコガスキデス', true, [true, true, true, true]],
    ['the written form', NEKO, '猫が好きです', true, [true, true, true, true]],
    ['one word missed', NEKO, 'ねこがすしです', false, [true, true, false, true]],
    ['first word missed', NEKO, 'いぬがすきです', false, [false, true, true, true]],
    ['empty', NEKO, '', false, [false, false, false, false]],
    ['particle は written as わ', HON, 'これわほんです', true, [true, true, true, true]],
    ['particle は written as は', HON, 'これはほんです', true, [true, true, true, true]],
    ['long-vowel mark spelled out', COFFEE, 'まいにちこおひいをのむ', true, [true, true, true, true]],
    ['を heard as お', COFFEE, 'まいにちこーひーおのむ', true, [true, true, true, true]],
    ['short vowel where long is said', COFFEE, 'まいにちこひをのむ', false, [true, false, true, true]],
  ] as const)('%s', (_name, segments, answer, correct, heard) => {
    const g = gradeDictation([...segments], answer);
    expect(g.correct).toBe(correct);
    expect(g.heard).toEqual(heard);
  });

  it.each([
    ['コーヒー', 'こおひい'],
    ['ラーメン', 'らあめん'],
    ['を', 'お'],
    ['  ねこ。', 'ねこ'],
  ])('normalizes %s to %s', (input, out) => {
    expect(normalizeReading(input)).toBe(out);
  });
});

describe('activity registry', () => {
  it('declares every field for every type', () => {
    for (const t of activityTypes()) {
      expect(['input', 'output', 'study', 'fluency']).toContain(t.strand);
      expect(['code', 'model']).toContain(t.grading);
      expect(typeof t.closed).toBe('boolean');
      expect(t.stages.length).toBeGreaterThan(0);
      expect(typeof t.candidates).toBe('function');
    }
  });

  it('is keyed by type id', () => {
    for (const [key, t] of Object.entries(REGISTRY)) expect(t.id).toBe(key);
  });

  it.each([
    ['introduce', 'study', false],
    ['retrieval', 'study', true],
    ['minimal_pair', 'study', true],
    ['dictation', 'input', true],
  ] as const)('%s is %s, closed %s, code-graded', (id, strand, closed) => {
    expect(REGISTRY[id]).toMatchObject({ strand, closed, grading: 'code' });
  });
});
