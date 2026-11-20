import { EXTRA_CLUSTER } from './content/reading';
import type { Catalog, CatalogData, Cluster, DictationSentence, GrammarPoint, Item, ItemEdge, MinimalPair } from './types';

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
  const written = group(data.items, (i) => [i.written]);
  for (const list of written.values()) list.sort((a, b) => a.order - b.order);
  for (const list of members.values()) list.sort((a, b) => a.order - b.order);
  const stored = group(data.edges, (e) => [e.to]);
  const pairs = new Map((data.pairs ?? []).map((p) => [p.id, p]));
  const pairsBy = group(data.pairs ?? [], (p) => [p.itemId]);
  const sentencesBy = group(data.sentences ?? [], (s: DictationSentence) => [
    ...new Set(s.segments.flatMap((g) => (g.itemId ? [g.itemId] : []))),
  ]);
  const computed = new Map<string, ItemEdge[]>();
  // The approval gate: drafts are dropped here, so nothing past the catalog can see them.
  const grammar = (data.grammar ?? []).filter(isApproved);
  const aliases = new Map(Object.entries(data.aliases ?? {}));

  return {
    item: (id) => items.get(id),
    resolve: (id) => aliases.get(id) ?? id,
    clusters: (): Cluster[] => [...clusters.values()],
    cluster: (id) => clusters.get(id),
    inCluster: (id) => members.get(id) ?? [],
    byWritten: (w) => written.get(w) ?? [],
    grammar: () => grammar,
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
    extend(added) {
      for (const raw of added) {
        const id = aliases.get(raw.id) ?? raw.id;
        if (items.has(id)) continue;
        // Anything not already listed is a word from a passage, whatever group a stored copy says: it goes to the
        // extra group, taught only when looked up, so a word later dropped from the list cannot come back into a band.
        const item: Item = { ...raw, id, cluster: EXTRA_CLUSTER };
        items.set(id, item);
        const same = written.get(item.written) ?? [];
        same.push(item);
        same.sort((a, b) => a.order - b.order);
        written.set(item.written, same);
        const list = members.get(item.cluster) ?? [];
        list.push(item);
        list.sort((a, b) => a.order - b.order);
        members.set(item.cluster, list);
      }
    },
  };
}

/** Approved means a named reviewer and a date, not just the word. */
export function isApproved(p: GrammarPoint): boolean {
  return p.factSheet.status === 'approved' && !!p.factSheet.approvedBy?.trim() && !!p.factSheet.approvedAt?.trim();
}

export const grammarItemId = (pointId: string) => `grammar:${pointId}`;

/** The cluster grammar items live in. They are reached through grammar activities, never the word frontier. */
export const GRAMMAR_CLUSTER = 'grammar';

/** Learner items for approved grammar points: recognition only for now, practised by contrast choice. */
export function grammarItems(points: GrammarPoint[]): Item[] {
  return points.filter(isApproved).map((p) => ({
    id: grammarItemId(p.id),
    language: 'ja',
    type: 'grammar',
    written: p.label,
    reading: '',
    gloss: [p.label],
    skills: ['read'],
    cluster: GRAMMAR_CLUSTER,
    order: 500_000 + (p.tags.genki ?? 99) * 100,
    tags: { ...(p.tags.genki ? { genki: p.tags.genki } : {}), ...(p.tags.jlpt ? { jlpt: p.tags.jlpt } : {}) },
  }));
}
