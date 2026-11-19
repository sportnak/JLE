import { describe, expect, it } from 'vitest';
import { grade, normalizeEnglish } from '../src/grading';
import type { Item } from '../src/types';

const item = (written: string, reading: string, gloss: string[] = [], type: Item['type'] = 'vocab'): Item => ({
  id: `t:${written}`,
  language: 'ja',
  type,
  written,
  reading,
  gloss,
  skills: ['read', 'write'],
  cluster: 'c',
  order: 0,
  tags: {},
});

describe('kana_to_reading', () => {
  it.each([
    ['か', 'ka', true],
    ['カ', 'ka', true],
    ['し', 'si', true],
    ['し', 'shi', true],
    ['きゃ', 'kya', true],
    ['ぢ', 'ji', true],
    ['づ', 'zu', true],
    ['を', 'o', true],
    ['を', 'wo', true],
    ['か', 'ga', false],
    ['か', '', false],
  ])('%s answered %j → %s', (kana, answer, ok) => {
    expect(grade(item(kana, kana, [], 'script'), 'kana_to_reading', answer).correct).toBe(ok);
  });

  it('shows a wrong answer in kana and explains a split combined sound', () => {
    const g = grade(item('ちゃ', 'ちゃ', [], 'script'), 'kana_to_reading', 'chiya');
    expect(g.correct).toBe(false);
    expect(g.note).toBe('You typed ちや. That is two sounds. ちゃ is one: the small ゃ blends into ち.');
    expect(g.note).not.toContain('chiya');
  });

  it('notes only what was typed for other mistakes', () => {
    expect(grade(item('き', 'き', [], 'script'), 'kana_to_reading', 'ka').note).toBe('You typed か.');
    expect(grade(item('キャ', 'キャ', [], 'script'), 'kana_to_reading', 'kiya').note).toContain('キャ is one');
  });

  it('reports the expected answer in kana, never romaji', () => {
    expect(grade(item('シ', 'シ', [], 'script'), 'kana_to_reading', 'x').expected).toBe('シ');
  });
});

describe('en_to_ja', () => {
  it.each([
    ['食べる', 'たべる', 'taberu', true],
    ['食べる', 'たべる', 'たべる', true],
    ['食べる', 'たべる', '食べる', true],
    ['コーヒー', 'コーヒー', 'ko-hi-', true],
    ['コーヒー', 'コーヒー', 'コーヒー', true],
    ['学校', 'がっこう', 'gakkou', true],
    ['学校', 'がっこう', 'gakou', false],
    ['食べる', 'たべる', 'nomu', false],
  ])('%s answered %j → %s', (written, reading, answer, ok) => {
    expect(grade(item(written, reading), 'en_to_ja', answer).correct).toBe(ok);
  });
});

describe('ja_to_en', () => {
  const eat = item('食べる', 'たべる', ['to eat']);
  const hot = item('暑い', 'あつい', ['hot (weather)']);
  it.each([
    [eat, 'eat', true],
    [eat, 'to eat', true],
    [eat, 'To Eat!', true],
    [eat, 'drink', false],
    [hot, 'hot', true],
    [item('先生', 'せんせい', ['teacher']), 'teacher', true],
    [item('先生', 'せんせい', ['teacher']), 'teahcer', true],
    [item('犬', 'いぬ', ['dog']), 'dot', false],
  ])('%#: %j', (it, answer, ok) => {
    expect(grade(it, 'ja_to_en', answer).correct).toBe(ok);
  });

  it('normalizes articles, parentheticals and punctuation', () => {
    expect(normalizeEnglish('  The (my) Father. ')).toBe('father');
  });
});
