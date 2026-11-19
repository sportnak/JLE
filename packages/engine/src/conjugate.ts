/**
 * Common inflected forms of verbs and adjectives, so an answer that is the right word in another form
 * can be recognised. Works on the trailing kana only, so it applies to written and reading forms alike.
 */

export type Pos = 'v1' | 'v5' | 'v5-iku' | 'v5-aru' | 'vk' | 'vs' | 'adj-i' | 'adj-ii' | 'adj-na';

const I_ROW: Record<string, string> = { う: 'い', く: 'き', ぐ: 'ぎ', す: 'し', つ: 'ち', ぬ: 'に', ぶ: 'び', む: 'み', る: 'り' };
const A_ROW: Record<string, string> = { う: 'わ', く: 'か', ぐ: 'が', す: 'さ', つ: 'た', ぬ: 'な', ぶ: 'ば', む: 'ま', る: 'ら' };
const TE: Record<string, [string, string]> = {
  う: ['って', 'った'],
  つ: ['って', 'った'],
  る: ['って', 'った'],
  む: ['んで', 'んだ'],
  ぶ: ['んで', 'んだ'],
  ぬ: ['んで', 'んだ'],
  く: ['いて', 'いた'],
  ぐ: ['いで', 'いだ'],
  す: ['して', 'した'],
};

export interface Form {
  text: string;
  label: string;
}

function verb(masuStem: string, negStem: string, te: string, ta: string): Form[] {
  return [
    { text: `${masuStem}ます`, label: 'polite form' },
    { text: `${masuStem}ません`, label: 'polite negative' },
    { text: `${masuStem}ました`, label: 'polite past' },
    { text: `${masuStem}ませんでした`, label: 'polite past negative' },
    { text: `${masuStem}たい`, label: 'たい form' },
    { text: `${negStem}ない`, label: 'negative form' },
    { text: `${negStem}なかった`, label: 'past negative' },
    { text: te, label: 'て-form' },
    { text: ta, label: 'past form' },
  ];
}

/** Inflected forms of `base` (its dictionary form). The dictionary form itself is not included. */
export function inflections(base: string, pos: Pos): Form[] {
  const head = base.slice(0, -1);
  const end = base.slice(-1);
  switch (pos) {
    case 'v1':
      return verb(head, head, `${head}て`, `${head}た`);
    case 'v5': {
      const [te, ta] = TE[end] ?? ['', ''];
      return verb(head + (I_ROW[end] ?? ''), head + (A_ROW[end] ?? ''), head + te, head + ta);
    }
    case 'v5-iku':
      return verb(`${head}き`, `${head}か`, `${head}って`, `${head}った`);
    case 'v5-aru':
      // ある's negative is just ない / なかった.
      return verb(`${head}り`, '', `${head}って`, `${head}った`);
    case 'vk': {
      // In kana the く changes (くる → きます, こない); in kanji only the る goes (来る → 来ます, 来ない).
      const kana = base.at(-2) === 'く';
      const stem = kana ? base.slice(0, -2) : head;
      const [i, o] = kana ? ['き', 'こ'] : ['', ''];
      return verb(`${stem}${i}`, `${stem}${o}`, `${stem}${i}て`, `${stem}${i}た`);
    }
    case 'vs': {
      const stem = base.slice(0, -2);
      return verb(`${stem}し`, `${stem}し`, `${stem}して`, `${stem}した`);
    }
    case 'adj-i':
    case 'adj-ii': {
      const stem = pos === 'adj-ii' ? `${base.slice(0, -2)}よ` : head;
      return [
        { text: `${base}です`, label: 'polite form' },
        { text: `${stem}くない`, label: 'negative form' },
        { text: `${stem}くないです`, label: 'polite negative' },
        { text: `${stem}かった`, label: 'past form' },
        { text: `${stem}かったです`, label: 'polite past' },
        { text: `${stem}くなかった`, label: 'past negative' },
        { text: `${stem}くて`, label: 'て-form' },
      ];
    }
    case 'adj-na':
      return [
        { text: `${base}です`, label: 'polite form' },
        { text: `${base}だ`, label: 'plain form with だ' },
        { text: `${base}じゃない`, label: 'negative form' },
        { text: `${base}じゃありません`, label: 'polite negative' },
        { text: `${base}でした`, label: 'polite past' },
      ];
  }
}
