import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryCatalog } from '@jle/engine';
import { GRAMMAR, POINT_FILES, validatePoint } from '../src/index';

const dir = join(import.meta.dirname, '../points');

describe('grammar points', () => {
  it('every file in points/ is listed and valid', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
    expect(GRAMMAR.map((p) => p.id).sort()).toEqual(files);
    expect(POINT_FILES.length).toBe(files.length);
    for (const p of POINT_FILES) expect(validatePoint(p), (p as { id: string }).id).toEqual([]);
  });

  it('references between points name real points', () => {
    const ids = new Set(GRAMMAR.map((p) => p.id));
    for (const p of GRAMMAR) for (const r of [...p.prerequisites, ...p.confusables]) expect(ids.has(r), `${p.id} → ${r}`).toBe(true);
  });

  it('an approval needs a reviewer and a date', () => {
    const base = structuredClone(GRAMMAR[0]!) as unknown as { factSheet: Record<string, unknown> };
    base.factSheet = { status: 'approved', body: 'x' };
    expect(validatePoint(base)).toEqual(expect.arrayContaining(['an approved fact sheet needs approvedBy']));
  });

  it('the catalog keeps only approved points: a draft never gets through', () => {
    const draft = GRAMMAR[0]!;
    const approved = { ...GRAMMAR[1]!, factSheet: { ...GRAMMAR[1]!.factSheet, status: 'approved' as const, approvedBy: 'A Reviewer', approvedAt: '2026-11-21' } };
    const half = { ...GRAMMAR[2]!, factSheet: { ...GRAMMAR[2]!.factSheet, status: 'approved' as const } };
    const catalog = memoryCatalog({ items: [], edges: [], clusters: [], grammar: [draft, approved, half] });
    expect(catalog.grammar().map((p) => p.id)).toEqual([approved.id]);
  });

  it('gives each gap two different forms and never romaji', () => {
    for (const p of GRAMMAR) for (const c of p.contrasts) expect(c.answer, p.id).not.toBe(c.other);
  });
});
