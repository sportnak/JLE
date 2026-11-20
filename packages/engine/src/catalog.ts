import type { Catalog, CatalogData, Cluster, DictationSentence, Item, ItemEdge, MinimalPair } from './types';

function group<T>(rows: T[], keyOf: (row: T) => string[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) for (const k of keyOf(row)) out.set(k, [...(out.get(k) ?? []), row]);
  return out;
}

/**
 * A catalog held in memory and indexed once. `computeEdges`, when given, supplies edges into an item on
 * request (word → kana from its reading) instead of storing them for every item.
 */
export function memoryCatalog(data: CatalogData, computeEdges?: (item: Item) => ItemEdge[]): Catalog {
  const items = new Map(data.items.map((i) => [i.id, i]));
  const clusters = new Map(data.clusters.map((c) => [c.id, c]));
  const members = group(data.items, (i) => [i.cluster]);
  for (const list of members.values()) list.sort((a, b) => a.order - b.order);
  const stored = group(data.edges, (e) => [e.to]);
  const pairs = new Map((data.pairs ?? []).map((p) => [p.id, p]));
  const pairsBy = group(data.pairs ?? [], (p) => [p.itemId]);
  const sentencesBy = group(data.sentences ?? [], (s: DictationSentence) => [
    ...new Set(s.segments.flatMap((g) => (g.itemId ? [g.itemId] : []))),
  ]);
  const computed = new Map<string, ItemEdge[]>();

  return {
    item: (id) => items.get(id),
    clusters: (): Cluster[] => [...clusters.values()],
    cluster: (id) => clusters.get(id),
    inCluster: (id) => members.get(id) ?? [],
    edgesInto(id) {
      const own = stored.get(id) ?? [];
      const item = computeEdges && items.get(id);
      if (!item) return own;
      if (!computed.has(id)) computed.set(id, computeEdges!(item));
      return [...own, ...computed.get(id)!];
    },
    pair: (id): MinimalPair | undefined => pairs.get(id),
    pairsFor: (id) => pairsBy.get(id) ?? [],
    sentencesWith: (id) => sentencesBy.get(id) ?? [],
  };
}
