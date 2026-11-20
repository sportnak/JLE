/**
 * The grammar point schema, checked in code (no schema library): every point file is validated when the package
 * loads and in its tests, so a malformed or half-approved file fails the build.
 */
const STEP_KEYS = new Set(['surface', 'lemma', 'pos', 'form']);

export function validatePoint(raw: unknown): string[] {
  const e: string[] = [];
  if (!raw || typeof raw !== 'object') return ['not an object'];
  const p = raw as Record<string, unknown>;
  const str = (k: string) => typeof p[k] === 'string' && (p[k] as string).trim() !== '';
  if (!str('id') || !/^[a-z0-9-]+$/.test(p.id as string)) e.push('id must be lowercase letters, digits and dashes');
  if (!Number.isInteger(p.version) || (p.version as number) < 1) e.push('version must be a positive integer');
  if (!str('label')) e.push('label is required');
  const tags = p.tags as Record<string, unknown> | undefined;
  if (!tags || typeof tags !== 'object') e.push('tags is required');
  else {
    if (tags.genki !== undefined && !Number.isInteger(tags.genki)) e.push('tags.genki must be a chapter number');
    if (tags.jlpt !== undefined && !/^N[1-5]$/.test(String(tags.jlpt))) e.push('tags.jlpt must be N1–N5');
  }
  for (const k of ['prerequisites', 'confusables']) {
    if (!Array.isArray(p[k]) || !(p[k] as unknown[]).every((x) => typeof x === 'string')) e.push(`${k} must be a list of point ids`);
  }
  if (!Array.isArray(p.matcher) || p.matcher.length === 0) e.push('matcher must be a non-empty list of alternatives');
  else
    for (const alt of p.matcher as unknown[]) {
      if (!Array.isArray(alt) || alt.length === 0) {
        e.push('each matcher alternative must be a non-empty list of steps');
        continue;
      }
      for (const step of alt as Record<string, unknown>[]) {
        const keys = Object.keys(step ?? {});
        if (keys.length === 0 || keys.some((k) => !STEP_KEYS.has(k) || typeof step[k] !== 'string')) e.push(`bad matcher step ${JSON.stringify(step)}`);
        if (step?.form !== undefined && step.form !== 'te') e.push(`unknown matcher form ${String(step.form)}`);
      }
    }
  const fs = p.factSheet as Record<string, unknown> | undefined;
  if (!fs || typeof fs !== 'object') e.push('factSheet is required');
  else {
    if (fs.status !== 'draft' && fs.status !== 'approved') e.push('factSheet.status must be draft or approved');
    if (typeof fs.body !== 'string' || !fs.body.trim()) e.push('factSheet.body is required');
    if (fs.status === 'approved') {
      if (typeof fs.approvedBy !== 'string' || !fs.approvedBy.trim()) e.push('an approved fact sheet needs approvedBy');
      if (typeof fs.approvedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(fs.approvedAt)) e.push('an approved fact sheet needs approvedAt (YYYY-MM-DD)');
    }
  }
  if (!Array.isArray(p.contrasts)) e.push('contrasts must be a list');
  else
    for (const [i, c] of (p.contrasts as Record<string, unknown>[]).entries()) {
      const ok = ['sentence', 'answer', 'other', 'translation'].every((k) => typeof c?.[k] === 'string' && (c[k] as string).trim());
      if (!ok) e.push(`contrast ${i} needs sentence, answer, other and translation`);
      else {
        if ((c.sentence as string).split('＿').length !== 2) e.push(`contrast ${i}: the sentence needs exactly one gap (＿)`);
        if (c.answer === c.other) e.push(`contrast ${i}: the two forms are the same`);
        if (/[A-Za-z]/.test(c.sentence as string)) e.push(`contrast ${i}: no romaji in the sentence`);
      }
    }
  return e;
}
