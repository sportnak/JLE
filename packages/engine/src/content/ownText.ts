import type { LearnerModel } from '../learner';
import type { Dictionary, Ids, Tokenizer } from '../ports';
import type { StoredContent } from '../types';
import { checkPassage, mapTokens } from './reading';

export const OWN_TEXT_VERSION = 'learner-1';

/**
 * Splits a text into parts of about `max` characters at sentence ends (。！？ and line breaks), so each part is one
 * passage. A sentence longer than `max` stays whole.
 */
export function splitText(text: string, max = 160): string[] {
  const sentences = text
    .replace(/\r\n?/g, '\n')
    .split(/(?<=[。！？!?])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const parts: string[] = [];
  let current = '';
  for (const s of sentences) {
    if (current && [...current, ...s].length > max) {
      parts.push(current);
      current = '';
    }
    current += s;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * A text the learner brought, as stored content: split into parts, tokenized and mapped like any passage. Coverage
 * is recorded, not enforced: your own text is read with lookups and furigana however hard it is (architecture §6).
 */
export async function ownTextContent(
  ports: { tokenizer: Tokenizer; dictionary: Dictionary },
  model: LearnerModel,
  input: { title: string; text: string },
  opts: { learnerId: string; now: Date; ids: Ids },
): Promise<StoredContent[]> {
  // Parts with no word the dictionary knows (English, symbols) are dropped: they could never be offered as reading.
  const mappedParts = [];
  for (const text of splitText(input.text)) {
    const mapped = await mapTokens(await ports.tokenizer.analyze(text), ports.dictionary, model.catalog);
    if (mapped.tokens.some((t) => t.itemId)) mappedParts.push({ text, mapped });
  }
  if (mappedParts.length === 0) throw new Error('No Japanese words were found in the text.');
  const parts = mappedParts.map((p) => p.text);
  const series = opts.ids.next();
  const out: StoredContent[] = [];
  for (const [i, { text, mapped }] of mappedParts.entries()) {
    const check = checkPassage(model, text, mapped.tokens, [], model.config);
    out.push({
      id: opts.ids.next(),
      learnerId: opts.learnerId,
      // Parts a millisecond apart, so they sort in order after any other content of the same moment.
      createdAt: new Date(opts.now.getTime() + i).toISOString(),
      source: 'learner',
      promptVersion: OWN_TEXT_VERSION,
      model: 'none',
      title: parts.length > 1 ? `${input.title} (${i + 1}/${parts.length})` : input.title,
      text,
      translation: '',
      tokens: mapped.tokens,
      items: mapped.items,
      targets: [],
      coverage: check.coverage,
      series: { id: series, part: i + 1, of: parts.length },
    });
  }
  return out;
}
