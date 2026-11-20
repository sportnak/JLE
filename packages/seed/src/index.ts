import { EXTRA_CLUSTER, GRAMMAR_CLUSTER, grammarItems, memoryCatalog, type GrammarPoint, type Catalog, type CatalogData, type Cluster, type DictationSentence, type Item, type ItemEdge, type MinimalPair } from '@jle/engine';
import { FEATURES, PAIRS, pairId } from '@jle/sounds';
import { toHiragana } from 'wanakana';
import { GRAMMAR } from '@jle/grammar';
import { kanaCatalog, kanaId, moraeOf } from './kana';
import { GLUE, SENTENCES } from './sentences';
import { STARTER_POS, STARTER_VOCAB } from './vocab';
import { STARTER_ALIASES, STARTER_COUNT, WORDS, wordId } from './words';

const STARTER_BAND = 20;
const WORD_BAND = 100;

/** The starter catalog, indexed. Word → kana edges are computed from each word's reading when asked for. */
export function buildCatalog(grammar?: GrammarPoint[]): Catalog {
  const data = buildCatalogData(grammar);
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

/**
 * The static tables behind the catalog. Stored edges are the kana's own; word edges are computed. Grammar points are
 * passed in full, drafts included; the catalog keeps only approved ones. `grammar` replaces the repo's points in tests.
 */
export function buildCatalogData(grammar: GrammarPoint[] = GRAMMAR): CatalogData {
  const kana = kanaCatalog();
  const kanaIds = new Set(kana.items.map((i) => i.id));
  const items: Item[] = [...kana.items];
  const edges: ItemEdge[] = [...kana.edges];
  const clusters: Cluster[] = [...kana.clusters];
  const starterWritten = new Map(Object.entries(STARTER_ALIASES).map(([was, now]) => [now, was.slice('vocab:'.length)]));
  const starterBands = Math.ceil(STARTER_COUNT / STARTER_BAND);
  const wordBands = Math.ceil((WORDS.length - STARTER_COUNT) / WORD_BAND);
  const bandOf = (i: number) =>
    i < STARTER_COUNT ? `vocab-band-${Math.floor(i / STARTER_BAND) + 1}` : `words-${Math.floor((i - STARTER_COUNT) / WORD_BAND) + 1}`;

  for (let b = 0; b < starterBands; b++) {
    clusters.push({
      id: `vocab-band-${b + 1}`,
      track: 'vocab',
      order: 100 + b,
      label: `Starter words ${b * STARTER_BAND + 1}–${Math.min((b + 1) * STARTER_BAND, STARTER_COUNT)}`,
      requires: ['hiragana-basic'],
    });
  }
  for (let b = 0; b < wordBands; b++) {
    const from = STARTER_COUNT + b * WORD_BAND + 1;
    clusters.push({
      id: `words-${b + 1}`,
      track: 'vocab',
      order: 1000 + b,
      label: `Common words ${from}–${Math.min(from + WORD_BAND - 1, WORDS.length)}`,
      requires: ['hiragana-basic'],
    });
  }

  WORDS.forEach((w, i) => {
    const id = wordId(w.jmdictId);
    const starter = i < STARTER_COUNT ? starterWritten.get(id) : undefined;
    const own = starter !== undefined ? STARTER_VOCAB.find(([written]) => written === starter) : undefined;
    const pos = (starter !== undefined && STARTER_POS[starter]) || w.pos;
    items.push({
      id,
      language: 'ja',
      type: 'vocab',
      // A starter word keeps the form and meanings it was taught with; the dictionary's are accepted too.
      written: own ? own[0] : w.written,
      reading: w.reading,
      gloss: own ? [...new Set([...own[2].split(';').map((g) => g.trim()), ...w.gloss])] : w.gloss,
      skills: ['read', 'write', 'listen'],
      cluster: bandOf(i),
      order: 1000 + i,
      tags: { ...(own ? { jlpt: 'N5' } : {}), ...(w.freqRank ? { freq: w.freqRank } : {}) },
      ...(pos ? { pos } : {}),
    });
  });

  // Grammar points, reached through contrast choice; never walked in order like words.
  clusters.push({ id: GRAMMAR_CLUSTER, track: 'grammar', order: 90_000, label: 'Grammar', wantedOnly: true });
  items.push(...grammarItems(grammar));

  // Words beyond the list, brought in by passages; taught only when looked up.
  clusters.push({ id: EXTRA_CLUSTER, track: 'reading', order: 100_000, label: 'Words from your reading', wantedOnly: true });

  const sounds = soundCatalog(kanaIds);
  return {
    items: [...items, ...sounds.items],
    edges,
    clusters: [...clusters, sounds.cluster],
    pairs: sounds.pairs,
    sentences: dictationSentences(items.filter((i) => i.type === 'vocab' && i.order < 1000 + STARTER_COUNT)),
    aliases: STARTER_ALIASES,
    grammar,
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
export { ATTRIBUTION, STARTER_ALIASES, wordId } from './words';
export { LIBRARY } from './passages';
export { moraeOf } from './kana';
