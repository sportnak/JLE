// Builds out/reference.sqlite from the files fetch.ts put in sources/.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip, gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { SaxesParser } from 'saxes';
import { decode } from '@msgpack/msgpack';
import { SCHEMA, INDEXES, SCHEMA_VERSION } from '../src/schema.ts';
import { assignFrequency, candidateFor, compareCandidates, isCommon, isFunctionPos, matchKey, type FormCandidate, type HeadwordInfo } from '../src/frequency.ts';
import type { Manifest } from './manifest.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sources = join(root, 'sources');
const outDir = join(root, 'out');
const started = performance.now();

const manifestPath = join(sources, 'manifest.json');
if (!existsSync(manifestPath)) throw new Error('sources/manifest.json missing: run `pnpm --filter @jle/reference run fetch` first');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

// The DB is stamped with the manifest's sha256 and dates, so the files must be the ones it describes.
for (const [name, rec] of Object.entries(manifest)) {
  const file = join(sources, rec.file);
  if (!existsSync(file)) throw new Error(`sources/${rec.file} missing: run fetch`);
  const got = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (got !== rec.sha256) throw new Error(`sources/${rec.file} (${name}) sha256 ${got} does not match manifest ${rec.sha256}: re-run fetch`);
}

// --- XML streaming -------------------------------------------------------------------------

interface Node { name: string; attrs: Record<string, string>; text: string; kids: Node[] }

/**
 * Streams a gzipped XML file and hands each completed element named in `records` to `onRecord` as a small
 * tree. Custom DTD entities resolve to their own names (`&v5k;` -> "v5k").
 */
async function streamRecords(file: string, records: readonly string[], onRecord: (n: Node) => void, entities?: Map<string, string>) {
  const parser = new SaxesParser();
  const stack: Node[] = [];
  let error: Error | undefined;
  parser.on('error', (e) => { error ??= e; });
  parser.on('doctype', (dt) => {
    for (const m of dt.matchAll(/<!ENTITY\s+(\S+)\s+"([^"]*)"\s*>/g)) {
      parser.ENTITIES[m[1]!] = m[1]!;
      entities?.set(m[1]!, m[2]!);
    }
  });
  parser.on('opentag', (t) => {
    if (stack.length === 0 && !records.includes(t.name)) return;
    stack.push({ name: t.name, attrs: t.attributes as Record<string, string>, text: '', kids: [] });
  });
  parser.on('text', (s) => { const top = stack.at(-1); if (top) top.text += s; });
  parser.on('closetag', () => {
    const n = stack.pop();
    if (!n) return;
    const parent = stack.at(-1);
    if (parent) parent.kids.push(n);
    else onRecord(n);
  });
  const stream = createReadStream(file).pipe(createGunzip());
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    parser.write(chunk as string);
    if (error) throw error;
  }
  parser.close();
  if (error) throw error;
}

const all = (n: Node, name: string) => n.kids.filter((k) => k.name === name);
const texts = (n: Node, name: string) => all(n, name).map((k) => k.text.trim());
const first = (n: Node, name: string) => all(n, name)[0]?.text.trim();
const jsonOrNull = (a: readonly string[]) => (a.length ? JSON.stringify(a) : null);
const uniq = <T>(a: readonly T[]) => [...new Set(a)];

// --- Database ------------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
const finalPath = join(outDir, 'reference.sqlite');
const tmpPath = finalPath + '.tmp';
rmSync(tmpPath, { force: true });
const db = new DatabaseSync(tmpPath);
db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA page_size = 4096;');
db.exec(SCHEMA);
db.exec('BEGIN');

// --- JMdict --------------------------------------------------------------------------------

const insEntry = db.prepare(
  'INSERT INTO entry (id, written, reading, kana_only, priority, pos, gloss) VALUES (?, ?, ?, ?, ?, ?, ?)');
const insForm = db.prepare(
  'INSERT INTO form (entry_id, idx, text, kind, is_primary, info, pri, restr) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const insSense = db.prepare(
  'INSERT INTO sense (entry_id, idx, pos, misc, field, dial, stagk, stagr, info, gloss) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

const lookup = new Map<string, FormCandidate[]>();
const entities = new Map<string, string>();
const counts = { entries: 0, forms: 0, senses: 0, kanji: 0 };

function addCandidate(c: FormCandidate, text: string) {
  const key = matchKey(text);
  const list = lookup.get(key);
  if (!list) lookup.set(key, [c]);
  else {
    // One candidate per entry per key: keep the stronger one.
    const i = list.findIndex((x) => x.entryId === c.entryId);
    if (i < 0) list.push(c);
    else if (compareCandidates(c, list[i]!) < 0) list[i] = c;
  }
}

function onEntry(e: Node) {
  const id = Number(first(e, 'ent_seq'));
  const kEls = all(e, 'k_ele').map((k) => ({
    text: first(k, 'keb')!, info: texts(k, 'ke_inf'), pri: texts(k, 'ke_pri'),
  }));
  const rEls = all(e, 'r_ele').map((r) => ({
    text: first(r, 'reb')!, info: texts(r, 're_inf'), pri: texts(r, 're_pri'),
    restr: all(r, 're_nokanji').length ? [] : texts(r, 're_restr').length ? texts(r, 're_restr') : null,
  }));
  if (!id || rEls.length === 0) throw new Error(`malformed entry ${id}`);

  let lastPos: string[] = [];
  const senses = all(e, 'sense').map((s) => {
    const pos = texts(s, 'pos');
    if (pos.length) lastPos = pos;
    return {
      pos: lastPos, misc: texts(s, 'misc'), field: texts(s, 'field'), dial: texts(s, 'dial'),
      stagk: texts(s, 'stagk'), stagr: texts(s, 'stagr'), info: texts(s, 's_inf'),
      gloss: all(s, 'gloss').filter((g) => (g.attrs['xml:lang'] ?? 'eng') === 'eng').map((g) => g.text.trim()),
    };
  });

  // Search-only forms (sK, sk) are never the headword; an entry with only sK kanji is a kana word.
  // Rare (rK) and outdated (oK) kanji are the headword only when there is nothing better.
  const realKanji = kEls.filter((k) => !k.info.includes('sK'));
  const kanji = realKanji.find((k) => !k.info.includes('rK') && !k.info.includes('oK')) ?? realKanji[0];
  const readsWritten = (r: (typeof rEls)[number]) => !r.info.includes('sk') && (kanji
    ? r.restr === null || r.restr.includes(kanji.text)
    : true);
  const reading = rEls.find(readsWritten) ?? rEls.find((r) => !r.info.includes('sk')) ?? rEls[0]!;
  const written = kanji?.text ?? reading.text;
  // Kana-only also when every kanji form is rare (rK) or outdated (oK).
  const kanaOnly = !kanji || realKanji.every((k) => k.info.includes('rK') || k.info.includes('oK'))
    || (senses[0]?.misc.includes('uk') ?? false);
  const sensePos = senses.map((s) => s.pos);
  const hw: HeadwordInfo = {
    written, reading: reading.text, kanaOnly, hasKanji: !!kanji, readingPri: reading.pri,
    commonKana: rEls.filter((r) => !r.info.includes('sk') && isCommon(r.pri)).map((r) => r.text),
    func: sensePos.some(isFunctionPos),
    ukSense: senses.some((s) => s.misc.includes('uk')),
  };

  // entry.pos/gloss describe the headword pair, so skip senses stagk/stagr limit to other forms.
  const applies = (s: (typeof senses)[number]) =>
    (s.stagk.length === 0 || (!!kanji && s.stagk.includes(written))) &&
    (s.stagr.length === 0 || s.stagr.includes(reading.text));
  const shown = senses.some(applies) ? senses.filter(applies) : senses;
  const gloss = shown.slice(0, 3).map((s) => s.gloss.slice(0, 3).join('; ')).filter(Boolean);
  const priority = uniq([...kEls, ...rEls].flatMap((f) => f.pri));
  insEntry.run(id, written, reading.text, kanaOnly ? 1 : 0, priority.join(','), JSON.stringify(shown[0]?.pos ?? []), JSON.stringify(gloss));

  kEls.forEach((k, i) => {
    insForm.run(id, i, k.text, 'kanji', k === kanji ? 1 : 0, jsonOrNull(k.info), k.pri.join(',') || null, null);
    addCandidate(candidateFor(id, k.text, hw, k.pri, sensePos), k.text);
  });
  rEls.forEach((r, i) => {
    insForm.run(id, i, r.text, 'kana', r === reading ? 1 : 0, jsonOrNull(r.info), r.pri.join(',') || null,
      r.restr === null ? null : JSON.stringify(r.restr));
    addCandidate(candidateFor(id, r.text, hw, r.pri, sensePos), r.text);
  });
  senses.forEach((s, i) => {
    insSense.run(id, i, JSON.stringify(s.pos), jsonOrNull(s.misc), jsonOrNull(s.field), jsonOrNull(s.dial),
      jsonOrNull(s.stagk), jsonOrNull(s.stagr), s.info.length ? s.info.join('; ') : null, JSON.stringify(s.gloss));
  });
  counts.entries++;
  counts.forms += kEls.length + rEls.length;
  counts.senses += senses.length;
}

await streamRecords(join(sources, manifest.jmdict.file), ['entry'], onEntry, entities);
const insTag = db.prepare('INSERT INTO tag (name, description) VALUES (?, ?)');
for (const [name, desc] of entities) insTag.run(name, desc);
console.log(`JMdict: ${counts.entries} entries, ${counts.forms} forms, ${counts.senses} senses, ${entities.size} tags`);

// --- KANJIDIC2 -----------------------------------------------------------------------------

const insKanji = db.prepare(
  'INSERT INTO kanji (literal, grade, jlpt_old, freq, strokes, "on", kun, meanings) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
let kanjidicVersion = '';
await streamRecords(join(sources, manifest.kanjidic2.file), ['header', 'character'], (c) => {
  if (c.name === 'header') { kanjidicVersion = first(c, 'database_version') ?? ''; return; }
  const misc = all(c, 'misc')[0];
  const intOf = (s: string | undefined) => (s ? Number(s) : null);
  const groups = all(c, 'reading_meaning').flatMap((rm) => all(rm, 'rmgroup'));
  const readings = (type: string) => groups.flatMap((g) => all(g, 'reading').filter((r) => r.attrs.r_type === type).map((r) => r.text.trim()));
  const meanings = groups.flatMap((g) => all(g, 'meaning').filter((m) => !m.attrs.m_lang).map((m) => m.text.trim()));
  insKanji.run(first(c, 'literal')!, intOf(misc && first(misc, 'grade')), intOf(misc && first(misc, 'jlpt')),
    intOf(misc && first(misc, 'freq')), intOf(misc && first(misc, 'stroke_count')),
    JSON.stringify(readings('ja_on')), JSON.stringify(readings('ja_kun')), JSON.stringify(meanings));
  counts.kanji++;
});
console.log(`KANJIDIC2: ${counts.kanji} characters`);

// --- Frequency -----------------------------------------------------------------------------

const pack = decode(gunzipSync(readFileSync(join(sources, manifest.wordfreq.file)))) as unknown[];
const header = pack[0] as { format?: string; version?: number };
if (header?.format !== 'cB' || header.version !== 1) throw new Error(`unexpected wordfreq header ${JSON.stringify(header)}`);
const bins = pack.slice(1) as string[][];
// JLE_RANK_LOG=1 writes out/rank-log.tsv (rank, token, entry id), for reviewing which token ranked what.
const rankLog: string[] = [];
const ranked = assignFrequency(bins, (k) => lookup.get(k),
  process.env.JLE_RANK_LOG ? (token, id, r) => rankLog.push(`${r.rank}\t${token}\t${id}`) : undefined);
if (rankLog.length) writeFileSync(join(outDir, 'rank-log.tsv'), rankLog.join('\n') + '\n');
const setRank = db.prepare('UPDATE entry SET freq_rank = ?, zipf = ? WHERE id = ?');
for (const [id, r] of ranked) setRank.run(r.rank, r.zipf, id);
console.log(`wordfreq: ${bins.reduce((n, b) => n + b.length, 0)} tokens, ${ranked.size} entries ranked`);

// --- Meta ----------------------------------------------------------------------------------

const meta: Record<string, string> = {
  schema_version: String(SCHEMA_VERSION),
  build_date: new Date().toISOString(),
  jmdict_file: manifest.jmdict.file,
  jmdict_release: manifest.jmdict.releaseDate,
  jmdict_sha256: manifest.jmdict.sha256,
  kanjidic2_file: manifest.kanjidic2.file,
  kanjidic2_release: manifest.kanjidic2.releaseDate,
  kanjidic2_sha256: manifest.kanjidic2.sha256,
  kanjidic2_database_version: kanjidicVersion,
  wordfreq_version: manifest.wordfreq.version ?? '',
  wordfreq_file: manifest.wordfreq.file,
  wordfreq_release: manifest.wordfreq.releaseDate,
  wordfreq_sha256: manifest.wordfreq.sha256,
  wordfreq_wheel_sha256: manifest.wordfreq.archive?.sha256 ?? '',
  entry_count: String(counts.entries),
  ranked_count: String(ranked.size),
  attribution:
    'This database uses the JMdict and KANJIDIC2 dictionary files, the property of the Electronic Dictionary ' +
    'Research and Development Group (EDRDG), used in conformance with the Group\'s licence (CC BY-SA 4.0): ' +
    'https://www.edrdg.org/edrdg/licence.html. Word frequencies come from wordfreq (Robyn Speer. (2022). ' +
    'rspeer/wordfreq: v3.0 (v3.0.2). Zenodo. https://doi.org/10.5281/zenodo.7199437; data CC BY-SA 4.0); ' +
    'its Japanese list draws on Wikipedia, OpenSubtitles 2018 (opensubtitles.org, via OPUS), web text (OSCAR), ' +
    'Twitter and Reddit.',
};
const insMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(meta)) insMeta.run(k, v);

db.exec('COMMIT');
db.exec(INDEXES);
db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; ANALYZE; VACUUM;`);
db.close();
renameSync(tmpPath, finalPath);
const secs = ((performance.now() - started) / 1000).toFixed(1);
console.log(`wrote ${finalPath} (${(statSync(finalPath).size / 1e6).toFixed(1)} MB) in ${secs} s`);
