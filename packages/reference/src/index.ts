// Typed reads over reference.sqlite.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export { SCHEMA_VERSION } from './schema.ts';

export interface Entry {
  id: number;
  written: string;
  reading: string;
  kanaOnly: boolean;
  freqRank: number | null;
  zipf: number | null;
  priority: string[];
  pos: string[];
  gloss: string[];
  jlpt: number | null;
}

export interface Form {
  entryId: number;
  text: string;
  kind: 'kanji' | 'kana';
  isPrimary: boolean;
  info: string[];
  pri: string[];
  /** Kana only: the kanji forms this reading goes with; null means all of them. */
  restr: string[] | null;
}

export interface Sense {
  idx: number;
  pos: string[];
  misc: string[];
  field: string[];
  dial: string[];
  stagk: string[] | null;
  stagr: string[] | null;
  info: string | null;
  gloss: string[];
}

export interface Kanji {
  literal: string;
  grade: number | null;
  jlptOld: number | null;
  freq: number | null;
  strokes: number | null;
  on: string[];
  kun: string[];
  meanings: string[];
}

export const defaultReferencePath = (): string =>
  fileURLToPath(new URL('../out/reference.sqlite', import.meta.url));

export const openReference = (path = defaultReferencePath()): DatabaseSync =>
  new DatabaseSync(path, { readOnly: true });

type Row = Record<string, unknown>;
const json = <T>(v: unknown, empty: T): T => (v == null ? empty : (JSON.parse(String(v)) as T));
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const tags = (v: unknown): string[] => (v ? String(v).split(',') : []);

const toEntry = (r: Row): Entry => ({
  id: Number(r.id),
  written: String(r.written),
  reading: String(r.reading),
  kanaOnly: r.kana_only === 1,
  freqRank: num(r.freq_rank),
  zipf: num(r.zipf),
  priority: tags(r.priority),
  pos: json(r.pos, []),
  gloss: json(r.gloss, []),
  jlpt: num(r.jlpt),
});

const toForm = (r: Row): Form => ({
  entryId: Number(r.entry_id),
  text: String(r.text),
  kind: r.kind as Form['kind'],
  isPrimary: r.is_primary === 1,
  info: json(r.info, []),
  pri: tags(r.pri),
  restr: json<string[] | null>(r.restr, null),
});

/** Does this kana form read this kanji form? */
export const readsKanji = (kana: Form, kanji: string): boolean => kana.restr === null || kana.restr.includes(kanji);

const byRank = (a: Entry, b: Entry) =>
  (a.freqRank ?? Number.MAX_SAFE_INTEGER) - (b.freqRank ?? Number.MAX_SAFE_INTEGER) || a.id - b.id;

export function referenceReader(db: DatabaseSync) {
  const qEntry = db.prepare('SELECT * FROM entry WHERE id = ?');
  const qFormsByText = db.prepare('SELECT * FROM form WHERE text = ?');
  const qForms = db.prepare('SELECT * FROM form WHERE entry_id = ? ORDER BY kind DESC, idx');
  const qSenses = db.prepare('SELECT * FROM sense WHERE entry_id = ? ORDER BY idx');
  const qRank = db.prepare('SELECT * FROM entry WHERE freq_rank >= ? ORDER BY freq_rank LIMIT ?');
  const qKanji = db.prepare('SELECT * FROM kanji WHERE literal = ?');

  const entryById = (id: number): Entry | undefined => {
    const r = qEntry.get(id) as Row | undefined;
    return r ? toEntry(r) : undefined;
  };
  const forms = (entryId: number): Form[] => (qForms.all(entryId) as Row[]).map(toForm);

  return {
    entryById,
    forms,
    senses: (entryId: number): Sense[] =>
      (qSenses.all(entryId) as Row[]).map((r) => ({
        idx: Number(r.idx),
        pos: json(r.pos, []),
        misc: json(r.misc, []),
        field: json(r.field, []),
        dial: json(r.dial, []),
        stagk: json<string[] | null>(r.stagk, null),
        stagr: json<string[] | null>(r.stagr, null),
        info: r.info == null ? null : String(r.info),
        gloss: json(r.gloss, []),
      })),

    /**
     * Entries with a form spelled `text`, most frequent first. With `reading`, a kanji match must
     * have that reading for that spelling (re_restr respected); a kana match must equal it.
     */
    byLemma(text: string, reading?: string): Entry[] {
      const hits = (qFormsByText.all(text) as Row[]).map(toForm);
      const ids = new Set<number>();
      for (const f of hits) {
        if (ids.has(f.entryId)) continue;
        if (reading === undefined || (f.kind === 'kana' ? f.text === reading
          : forms(f.entryId).some((k) => k.kind === 'kana' && k.text === reading && readsKanji(k, text)))) {
          ids.add(f.entryId);
        }
      }
      return [...ids].map((id) => entryById(id)!).sort(byRank);
    },

    byFrequency: (fromRank: number, limit: number): Entry[] => (qRank.all(fromRank, limit) as Row[]).map(toEntry),

    kanji(literal: string): Kanji | undefined {
      const r = qKanji.get(literal) as Row | undefined;
      if (!r) return undefined;
      return {
        literal: String(r.literal),
        grade: num(r.grade),
        jlptOld: num(r.jlpt_old),
        freq: num(r.freq),
        strokes: num(r.strokes),
        on: json(r.on, []),
        kun: json(r.kun, []),
        meanings: json(r.meanings, []),
      };
    },

    meta(): Record<string, string> {
      const out: Record<string, string> = {};
      for (const r of db.prepare('SELECT key, value FROM meta').all() as Row[]) out[String(r.key)] = String(r.value);
      return out;
    },
  };
}

export type ReferenceReader = ReturnType<typeof referenceReader>;
