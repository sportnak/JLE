import { describe, expect, it } from 'vitest';
import { inflections } from '../src/conjugate';
import { grade } from '../src/grading';
import type { Item } from '../src/types';

const forms = (base: string, pos: Parameters<typeof inflections>[1]) =>
  Object.fromEntries(inflections(base, pos).map((f) => [f.label, f.text]));

describe('inflections', () => {
  it.each([
    ['たべる', 'v1', { 'polite form': 'たべます', 'negative form': 'たべない', 'て-form': 'たべて', 'past form': 'たべた' }],
    ['のむ', 'v5', { 'polite form': 'のみます', 'negative form': 'のまない', 'て-form': 'のんで', 'past form': 'のんだ' }],
    ['かう', 'v5', { 'negative form': 'かわない', 'て-form': 'かって' }],
    ['はなす', 'v5', { 'polite form': 'はなします', 'て-form': 'はなして' }],
    ['かえる', 'v5', { 'polite form': 'かえります', 'negative form': 'かえらない' }],
    ['いく', 'v5-iku', { 'て-form': 'いって', 'past form': 'いった', 'polite form': 'いきます' }],
    ['ある', 'v5-aru', { 'negative form': 'ない', 'past negative': 'なかった', 'polite form': 'あります' }],
    ['くる', 'vk', { 'polite form': 'きます', 'negative form': 'こない', 'past form': 'きた' }],
    ['来る', 'vk', { 'polite form': '来ます', 'negative form': '来ない' }],
    ['する', 'vs', { 'polite form': 'します', 'negative form': 'しない', 'て-form': 'して' }],
    ['たかい', 'adj-i', { 'negative form': 'たかくない', 'past form': 'たかかった', 'て-form': 'たかくて' }],
    ['いい', 'adj-ii', { 'negative form': 'よくない', 'past form': 'よかった' }],
    ['しずか', 'adj-na', { 'polite form': 'しずかです', 'negative form': 'しずかじゃない' }],
  ] as const)('%s (%s)', (base, pos, expected) => {
    expect(forms(base, pos)).toMatchObject(expected);
  });
});

describe('grading an inflected answer', () => {
  const eat: Item = {
    id: 'v', language: 'ja', type: 'vocab', written: '食べる', reading: 'たべる', gloss: ['to eat'],
    skills: ['read', 'write'], cluster: 'c', order: 0, tags: {}, pos: 'v1',
  };
  it('accepts the right word in another form, with a note', () => {
    const g = grade(eat, 'en_to_ja', 'tabemasu');
    expect(g.correct).toBe(true);
    expect(g.note).toBe('That is the polite form. The dictionary form is 食べる（たべる）.');
  });
  it('accepts written inflections too', () => {
    expect(grade(eat, 'en_to_ja', '食べました').correct).toBe(true);
  });
  it('still rejects a different word', () => {
    expect(grade(eat, 'en_to_ja', 'nomimasu').correct).toBe(false);
  });
  it('gives no note for the dictionary form', () => {
    expect(grade(eat, 'en_to_ja', 'taberu').note).toBeUndefined();
  });
});
