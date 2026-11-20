import type { ContentToken, GrammarPoint, TokenPattern } from '../types';

export interface GrammarSpan {
  pointId: string;
  begin: number;
  end: number;
}

/** Tokens one step takes at `i`, or 0 when it does not match there. */
function step(p: TokenPattern, tokens: ContentToken[], i: number): number {
  const t = tokens[i];
  if (!t) return 0;
  if (p.surface !== undefined && t.surface !== p.surface) return 0;
  if (p.lemma !== undefined && (t.lemma ?? t.surface) !== p.lemma) return 0;
  if (p.pos !== undefined && t.pos !== p.pos) return 0;
  if (p.form === 'te') {
    const next = tokens[i + 1];
    if (!(t.form ?? '').startsWith('連用形') || !next || next.pos !== '助詞' || (next.surface !== 'て' && next.surface !== 'で')) return 0;
    return 2;
  }
  return 1;
}

/**
 * Where grammar points occur in a passage: every place one of a point's alternatives matches consecutive tokens.
 * Run at read time over the points the catalog holds, which are approved ones only.
 */
export function matchGrammar(tokens: ContentToken[], points: GrammarPoint[]): GrammarSpan[] {
  const out: GrammarSpan[] = [];
  for (const point of points) {
    for (const alt of point.matcher) {
      for (let i = 0; i < tokens.length; i++) {
        let j = i;
        let ok = true;
        for (const s of alt) {
          const n = step(s, tokens, j);
          if (n === 0) {
            ok = false;
            break;
          }
          j += n;
        }
        if (ok) out.push({ pointId: point.id, begin: tokens[i]!.begin, end: tokens[j - 1]!.end });
      }
    }
  }
  return out.sort((a, b) => a.begin - b.begin || a.pointId.localeCompare(b.pointId));
}
