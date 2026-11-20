import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultReferencePath, openReference, referenceReader, SCHEMA_VERSION } from '../src/index.ts';

const path = defaultReferencePath();
const built = existsSync(path);
if (!built) console.warn(`reference.sqlite not built (${path}); skipping. Run: pnpm --filter @jle/reference run fetch && pnpm --filter @jle/reference build:db`);

describe.skipIf(!built)('reference.sqlite', () => {
  // Opened in beforeAll: vitest runs the describe body while collecting, even when it skips.
  let db: DatabaseSync;
  let ref: ReturnType<typeof referenceReader>;
  beforeAll(() => {
    db = openReference(path);
    ref = referenceReader(db);
  });
  afterAll(() => db?.close());

  it('is stamped with schema version and sources', () => {
    const meta = ref.meta();
    expect(meta.schema_version).toBe(String(SCHEMA_VERSION));
    for (const k of ['jmdict_release', 'jmdict_sha256', 'kanjidic2_release', 'wordfreq_version', 'attribution']) expect(meta[k]).toBeTruthy();
  });

  it('resolves 食べる to one entry', () => {
    const hits = ref.byLemma('食べる');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.reading).toBe('たべる');
    expect(hits[0]!.pos).toContain('v1');
    expect(hits[0]!.freqRank).toBeLessThan(2000);
  });

  it('ranks 日本 high', () => {
    expect(ref.byLemma('日本', 'にほん')[0]!.freqRank).toBeLessThan(200);
  });

  it('puts する, ある and いる in the top 200, as the right homographs', () => {
    const top = (lemma: string) => ref.byLemma(lemma)[0]!;
    expect(top('する').written).toBe('為る');
    expect(top('ある').written).toBe('有る');
    expect(top('いる').written).toBe('居る');
    for (const w of ['する', 'ある', 'いる']) expect(top(w).freqRank).toBeLessThanOrEqual(200);
  });

  it('reads 学校 as がっこう', () => {
    expect(ref.byLemma('学校')[0]!.reading).toBe('がっこう');
    expect(ref.byLemma('学校', 'がっこう')).toHaveLength(1);
  });

  it('respects re_restr when filtering by reading', () => {
    // おらあ is restricted to 俺, so 己 read おらあ is not that entry.
    expect(ref.byLemma('俺', 'おらあ').map((e) => e.id)).toContain(1576870);
    expect(ref.byLemma('己', 'おらあ').map((e) => e.id)).not.toContain(1576870);
    expect(ref.byLemma('今日', 'こんにち')[0]!.reading).toBe('きょう');
  });

  it('pages by frequency with dense ranks', () => {
    const page = ref.byFrequency(1, 50);
    expect(page).toHaveLength(50);
    expect(new Set(page.map((e) => e.id)).size).toBe(50);
    expect(page.map((e) => e.freqRank)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    const max = db.prepare('SELECT max(freq_rank) m, count(freq_rank) n FROM entry').get() as { m: number; n: number };
    expect(max.m).toBe(max.n);
  });

  it('reads kanji', () => {
    const k = ref.kanji('食')!;
    expect(k.strokes).toBe(9);
    expect(k.on).toContain('ショク');
    expect(k.meanings).toContain('eat');
  });

  it('returns homographs for はし', () => {
    const hits = ref.byLemma('はし');
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(hits.map((e) => e.written)).toEqual(expect.arrayContaining(['橋', '箸', '端']));
  });

  it('keeps entity names, not their expansions', () => {
    const s = ref.senses(ref.byLemma('書く')[0]!.id);
    expect(s[0]!.pos).toEqual(expect.arrayContaining(['v5k']));
    const tag = db.prepare("SELECT description FROM tag WHERE name = 'v5k'").get() as { description: string };
    expect(tag.description).toMatch(/Godan/);
  });
});
