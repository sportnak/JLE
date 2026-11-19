import type { Catalog, Cluster, Item, ItemEdge } from '@jle/engine';
import { kanaCatalog, kanaId, moraeOf } from './kana';
import { STARTER_POS, STARTER_VOCAB } from './vocab';

const BAND_SIZE = 20;

export function buildCatalog(): Catalog {
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
      skills: ['read', 'write'],
      cluster: `vocab-band-${Math.floor(i / BAND_SIZE) + 1}`,
      order: 1000 + i,
      tags: { jlpt: 'N5', freq: i + 1 },
      ...(STARTER_POS[written] ? { pos: STARTER_POS[written] } : {}),
    });
    for (const mora of new Set(moraeOf(reading))) {
      const from = kanaId(mora);
      if (kanaIds.has(from)) edges.push({ from, to: id, kind: 'component' });
    }
  });

  return { items, edges, clusters };
}

export { STARTER_VOCAB } from './vocab';
export { moraeOf } from './kana';
