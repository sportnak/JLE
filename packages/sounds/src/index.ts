/**
 * Sound features tracked as items, and the minimal pairs that practise them: authored data, like grammar.
 * Each pair is two real words, written in kana, that differ only in the feature.
 */

export type SoundFeature = 'vowel-length' | 'sokuon';

export interface FeatureDef {
  id: SoundFeature;
  /** Shown where the item is listed. */
  mark: string;
  label: string;
  /** How the longer word differs, with {long} for that word. */
  difference: string;
}

export const FEATURES: FeatureDef[] = [
  { id: 'vowel-length', mark: 'ー', label: 'long vowels', difference: '{long} holds one vowel for an extra beat.' },
  { id: 'sokuon', mark: 'っ', label: 'small っ', difference: '{long} has a short pause before the consonant: the small っ.' },
];

export interface PairDef {
  feature: SoundFeature;
  /** The shorter word, then the longer one: [kana, gloss]. */
  short: [string, string];
  long: [string, string];
}

const pair = (feature: SoundFeature, short: [string, string], long: [string, string]): PairDef => ({ feature, short, long });

export const PAIRS: PairDef[] = [
  pair('vowel-length', ['おばさん', 'aunt'], ['おばあさん', 'grandmother']),
  pair('vowel-length', ['おじさん', 'uncle'], ['おじいさん', 'grandfather']),
  pair('vowel-length', ['いえ', 'house'], ['いいえ', 'no']),
  pair('vowel-length', ['え', 'picture'], ['ええ', 'yes']),
  pair('vowel-length', ['ゆき', 'snow'], ['ゆうき', 'courage']),
  pair('vowel-length', ['くき', 'stem'], ['くうき', 'air']),
  pair('vowel-length', ['とり', 'bird'], ['とおり', 'street']),
  pair('vowel-length', ['へや', 'room'], ['へいや', 'plain (flat land)']),
  pair('vowel-length', ['きて', 'come (te-form)'], ['きいて', 'listen (te-form)']),
  pair('vowel-length', ['ビル', 'building'], ['ビール', 'beer']),
  pair('sokuon', ['きて', 'come (te-form)'], ['きって', 'stamp']),
  pair('sokuon', ['おと', 'sound'], ['おっと', 'husband']),
  pair('sokuon', ['かた', 'shoulder'], ['かった', 'bought']),
  pair('sokuon', ['さか', 'slope'], ['さっか', 'author']),
  pair('sokuon', ['いた', 'was there'], ['いった', 'went']),
  pair('sokuon', ['かこ', 'the past'], ['かっこ', 'brackets']),
  pair('sokuon', ['みつ', 'honey'], ['みっつ', 'three (things)']),
  pair('sokuon', ['もと', 'origin'], ['もっと', 'more']),
  pair('sokuon', ['せけん', 'society'], ['せっけん', 'soap']),
  pair('sokuon', ['ぶか', 'subordinate'], ['ぶっか', 'prices']),
];

export const pairId = (p: PairDef) => `pair:${p.short[0]}/${p.long[0]}`;
