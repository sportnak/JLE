import { describe, expect, it } from 'vitest';
import { engineGloss, enginePos, isFunctionWord, isWordReading, pickEntry } from '../src/slice';

describe('the app word list', () => {
  it('leaves grammar to grammar points and keeps content words', () => {
    expect(isFunctionWord(['prt'])).toBe(true);
    expect(isFunctionWord(['aux-v', 'cop'])).toBe(true);
    expect(isFunctionWord(['suf'])).toBe(true);
    expect(isFunctionWord(['n', 'suf'])).toBe(false);
    expect(isFunctionWord(['v1', 'vt'])).toBe(false);
    expect(isFunctionWord(['int'])).toBe(false);
  });

  it('takes words whose reading is kana, not symbols', () => {
    expect(isWordReading('たべる')).toBe(true);
    expect(isWordReading('コーヒー')).toBe(true);
    expect(isWordReading('ゝ')).toBe(false);
    expect(isWordReading('ー')).toBe(false);
    expect(isWordReading('ａ')).toBe(false);
  });

  it('maps only the inflection classes the engine conjugates correctly', () => {
    expect(enginePos(['v1', 'vt'])).toBe('v1');
    expect(enginePos(['v5k-s', 'vi'])).toBe('v5-iku');
    expect(enginePos(['v5r-i', 'vi'])).toBe('v5-aru');
    expect(enginePos(['v5m', 'vt'])).toBe('v5');
    expect(enginePos(['vk', 'vi'])).toBe('vk');
    expect(enginePos(['vs-i'])).toBe('vs');
    expect(enginePos(['adj-ix'])).toBe('adj-ii');
    expect(enginePos(['adj-na', 'n'])).toBe('adj-na');
    // いらっしゃる and 愛する conjugate irregularly; a suru noun is not する itself.
    expect(enginePos(['v5aru'])).toBeUndefined();
    expect(enginePos(['vs-s'])).toBeUndefined();
    expect(enginePos(['n', 'vs'])).toBeUndefined();
  });

  it('turns sense strings into separate accepted answers', () => {
    expect(engineGloss(['at; in; on', 'to; toward', 'at'])).toEqual(['at', 'in', 'on', 'to', 'toward']);
    expect(engineGloss(['a; b; c', 'd; e; f', 'g; h; i']).length).toBe(8);
  });

  it('maps a starter word to the ranked, common, primary entry', () => {
    const c = (id: number, rank: number | null, priority = '', primaryForm = 1) => ({ id, rank, priority, primaryForm });
    expect(pickEntry([c(3, null, 'ichi1'), c(2, 500)])).toBe(2);
    expect(pickEntry([c(3, null, ''), c(2, null, 'news1')])).toBe(2);
    expect(pickEntry([c(3, null, 'ichi1', 0), c(4, null, 'ichi1', 1)])).toBe(4);
    expect(pickEntry([c(9, null), c(5, null)])).toBe(5);
    expect(pickEntry([])).toBeUndefined();
  });
});
