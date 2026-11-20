import { memoryCatalog, type Catalog, type CatalogData, type Cluster, type DictationSentence, type Item, type ItemEdge, type MinimalPair } from '@jle/engine';
import { FEATURES, PAIRS, pairId } from '@jle/sounds';
import { toHiragana } from 'wanakana';
import { kanaCatalog, kanaId, moraeOf } from './kana';
import { GLUE, SENTENCES } from './sentences';
import { STARTER_POS, STARTER_VOCAB } from './vocab';

const BAND_SIZE = 20;

/** The starter catalog, indexed. Word → kana edges are computed from each word's reading when asked for. */
export function buildCatalog(): Catalog {
  const data = buildCatalogData();
  const kanaIds = new Set(data.items.filter((i) => i.type === 'script').map((i) => i.id));
  return memoryCatalog(data, (item) => (item.type === 'vocab' ? componentEdges(item, kanaIds) : []));
}

/** Kana in a word's reading, as component edges into the word. */
export function componentEdges(word: Item, kanaIds: Set<string>): ItemEdge[] {
  return [...new Set(moraeOf(word.reading))]
    .map(kanaId)
    .filter((from) => kanaIds.has(from))
    .map((from) => ({ from, to: word.id, kind: 'component' as const }));
}

/** The static tables behind the starter catalog. Stored edges are the kana's own; word edges are computed. */
export function buildCatalogData(): CatalogData {
  const kana = kanaCatalog();
  const kanaIds = new Set(kana.items.map((i) => i.id));
  const items: Item[] = [...kana.items];
  const edges: ItemEdge[] = [...kana.edges];
  const clusters: Cluster[] = [...kana.clusters];
  const bands = Math.ceil(STARTER_VOCAB.length / BAND_SIZE);

  for (let b = 0; b < bands; b++) {
    clusters.push({
      id: `vocab-band-${b + 1}`,
      track: 'vocab',
      order: 100 + b,
      label: `Starter words ${b * BAND_SIZE + 1}–${Math.min((b + 1) * BAND_SIZE, STARTER_VOCAB.length)}`,
      requires: ['hiragana-basic'],
    });
  }

  STARTER_VOCAB.forEach(([written, reading, gloss], i) => {
    const id = `vocab:${written}`;
    items.push({
      id,
      language: 'ja',
      type: 'vocab',
      written,
      reading,
      gloss: gloss.split(';').map((g) => g.trim()),
      skills: ['read', 'write', 'listen'],
      cluster: `vocab-band-${Math.floor(i / BAND_SIZE) + 1}`,
      order: 1000 + i,
      tags: { jlpt: 'N5', freq: i + 1 },
      ...(STARTER_POS[written] ? { pos: STARTER_POS[written] } : {}),
    });
  });

  const sounds = soundCatalog(kanaIds);
  return {
    items: [...items, ...sounds.items],
    edges,
    clusters: [...clusters, sounds.cluster],
    pairs: sounds.pairs,
    sentences: dictationSentences(items),
  };
}

export const soundId = (feature: string) => `sound:${feature}`;

function soundCatalog(kanaIds: Set<string>): { items: Item[]; cluster: Cluster; pairs: MinimalPair[] } {
  const cluster: Cluster = { id: 'sound-features', track: 'sound', order: 50, label: 'Sound features', requires: ['hiragana-basic'] };
  const items: Item[] = FEATURES.map((f, i) => ({
    id: soundId(f.id),
    language: 'ja',
    type: 'sound',
    written: f.mark,
    reading: f.mark,
    gloss: [f.label],
    skills: ['listen'],
    cluster: cluster.id,
    order: 500 + i,
    tags: {},
  }));
  const pairs: MinimalPair[] = PAIRS.map((p) => {
    const kana = [...new Set([...moraeOf(p.short[0]), ...moraeOf(p.long[0])])].map(kanaId);
    const missing = kana.filter((k) => !kanaIds.has(k));
    if (missing.length) throw new Error(`${pairId(p)} uses kana with no item: ${missing.join(' ')}`);
    const difference = FEATURES.find((f) => f.id === p.feature)!.difference.replace('{long}', p.long[0]);
    return {
      id: pairId(p),
      itemId: soundId(p.feature),
      a: { kana: p.short[0], gloss: p.short[1] },
      b: { kana: p.long[0], gloss: p.long[1] },
      difference,
      kana,
    };
  });
  return { items, cluster, pairs };
}

function dictationSentences(items: Item[]): DictationSentence[] {
  const byWritten = new Map(items.filter((i) => i.type === 'vocab').map((i) => [i.written, i]));
  return SENTENCES.map((parts) => {
    const segments = parts.map((part) => {
      const word = byWritten.get(part);
      if (word) return { text: word.written, reading: word.reading, itemId: word.id };
      const glue = GLUE[part];
      if (!glue) throw new Error(`Dictation part ${part} is neither a starter word nor glue`);
      return { text: part, reading: glue };
    });
    return { id: `dict:${toHiragana(segments.map((s) => s.reading).join(''))}`, segments };
  });
}

export { STARTER_VOCAB } from './vocab';
export { moraeOf } from './kana';
