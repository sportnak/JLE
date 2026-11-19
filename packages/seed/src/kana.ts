import { toKatakana } from 'wanakana';
import type { Cluster, Item, ItemEdge } from '@jle/engine';

const BASIC = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん';
const VOICED = 'がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ';
const YOON = ['き', 'し', 'ち', 'に', 'ひ', 'み', 'り', 'ぎ', 'じ', 'び', 'ぴ'].flatMap((c) => ['ゃ', 'ゅ', 'ょ'].map((s) => c + s));

export const kanaId = (kana: string) => `kana:${kana}`;

interface Group {
  key: string;
  label: string;
  chars: string[];
}

const HIRAGANA: Group[] = [
  { key: 'basic', label: 'basic', chars: [...BASIC] },
  { key: 'voiced', label: 'voiced (が, ぱ)', chars: [...VOICED] },
  { key: 'yoon', label: 'combined (きゃ)', chars: YOON },
];

export function kanaCatalog(): { items: Item[]; edges: ItemEdge[]; clusters: Cluster[] } {
  const items: Item[] = [];
  const edges: ItemEdge[] = [];
  const clusters: Cluster[] = [];
  let order = 0;

  for (const [scriptIdx, script] of (['hiragana', 'katakana'] as const).entries()) {
    const convert = (s: string) => (script === 'hiragana' ? s : toKatakana(s));
    for (const [groupIdx, group] of HIRAGANA.entries()) {
      const clusterId = `${script}-${group.key}`;
      clusters.push({
        id: clusterId,
        track: 'script',
        order: scriptIdx * 3 + groupIdx,
        label: `${script === 'hiragana' ? 'Hiragana' : 'Katakana'} ${group.label}`,
      });
      for (const ch of group.chars) {
        const kana = convert(ch);
        items.push({
          id: kanaId(kana),
          language: 'ja',
          type: 'script',
          written: kana,
          reading: kana,
          gloss: [],
          skills: ['read'],
          cluster: clusterId,
          order: order++,
          tags: {},
        });
        for (const base of baseKana(ch)) edges.push({ from: kanaId(convert(base)), to: kanaId(kana), kind: 'prerequisite' });
      }
    }
  }
  return { items, edges, clusters };
}

function baseKana(ch: string): string[] {
  if (ch.length === 2) {
    const big = { ゃ: 'や', ゅ: 'ゆ', ょ: 'よ' }[ch[1] as 'ゃ' | 'ゅ' | 'ょ'];
    return [ch[0]!, big];
  }
  const decomposed = ch.normalize('NFD');
  return decomposed.length > 1 ? [decomposed[0]!] : [];
}

/** Splits a kana string into the kana items it is made of; small っ and ー have no item of their own. */
export function moraeOf(reading: string): string[] {
  const out: string[] = [];
  for (const ch of reading) {
    if ('ゃゅょャュョ'.includes(ch) && out.length > 0) out[out.length - 1] += ch;
    else if (!'っッーぁぃぅぇぉァィゥェォ'.includes(ch)) out.push(ch);
  }
  return out;
}
