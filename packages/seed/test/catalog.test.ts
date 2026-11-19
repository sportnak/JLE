import { describe, expect, it } from 'vitest';
import { buildCatalog, moraeOf } from '../src/index';

const catalog = buildCatalog();
const ids = new Set(catalog.items.map((i) => i.id));

describe('seed catalog', () => {
  it('has 104 kana per script', () => {
    const script = catalog.items.filter((i) => i.type === 'script');
    expect(script.filter((i) => i.cluster.startsWith('hiragana')).length).toBe(104);
    expect(script.filter((i) => i.cluster.startsWith('katakana')).length).toBe(104);
  });

  it('has unique item ids', () => {
    expect(ids.size).toBe(catalog.items.length);
  });

  it('only has edges between existing items', () => {
    for (const e of catalog.edges) {
      expect(ids.has(e.from), e.from).toBe(true);
      expect(ids.has(e.to), e.to).toBe(true);
    }
  });

  it('links every vocabulary word to its kana', () => {
    for (const item of catalog.items.filter((i) => i.type === 'vocab')) {
      const parts = new Set(moraeOf(item.reading));
      const linked = catalog.edges.filter((e) => e.to === item.id).map((e) => e.from.replace('kana:', ''));
      expect(new Set(linked), item.written).toEqual(parts);
    }
  });

  it('assigns every item to a known cluster', () => {
    const clusters = new Set(catalog.clusters.map((c) => c.id));
    for (const item of catalog.items) expect(clusters.has(item.cluster), item.id).toBe(true);
  });

  it('splits morae with combined kana and skips small tsu and long vowels', () => {
    expect(moraeOf('しゅくだい')).toEqual(['しゅ', 'く', 'だ', 'い']);
    expect(moraeOf('がっこう')).toEqual(['が', 'こ', 'う']);
    expect(moraeOf('コーヒー')).toEqual(['コ', 'ヒ']);
  });
});
