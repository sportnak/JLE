// Lists grammar points and their review status: what is waiting for a reviewer.
//   pnpm --filter @jle/grammar status
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePoint } from '../src/schema.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../points');
const points = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
points.sort((a, b) => (a.tags?.genki ?? 99) - (b.tags?.genki ?? 99));
for (const p of points) {
  const errors = validatePoint(p);
  const fs = p.factSheet ?? {};
  const state = errors.length ? `INVALID: ${errors.join('; ')}` : fs.status === 'approved' ? `approved by ${fs.approvedBy} on ${fs.approvedAt}` : 'draft, waiting for review';
  console.log(`${String(p.id).padEnd(16)} v${p.version}  Genki ${String(p.tags?.genki ?? '-').padStart(2)}  ${state}`);
}
const waiting = points.filter((p) => p.factSheet?.status !== 'approved').length;
console.log(`\n${points.length} points, ${waiting} waiting for review.`);
