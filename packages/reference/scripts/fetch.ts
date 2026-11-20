// Downloads the source files into sources/ and records sha256 and release dates in sources/manifest.json.
// Downloads are data only: nothing from them is executed.
//
//   node scripts/fetch.ts            download, then replace sources/ and the manifest together
//   node scripts/fetch.ts --verify   download, and fail unless every sha256 matches the committed manifest
//
// Everything is downloaded into sources/.staging first; sources/ and manifest.json are only touched
// once every download has succeeded, so a failed run never leaves new files next to an old manifest.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import type { Manifest, SourceRecord } from './manifest.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sources = join(root, 'sources');
const staging = join(sources, '.staging');
const manifestPath = join(sources, 'manifest.json');
const UA = 'jle-reference-fetch/0.1';
const verify = process.argv.includes('--verify');

// wordfreq is no longer updated; 3.1.1 is its last release. Pinned so a rebuild uses the same list.
const WORDFREQ_VERSION = '3.1.1';
const WORDFREQ_WHEEL_SHA256 = '4b1c6ecffc6198be3396d5cf871c4423ca71c907c231348d352dd54d62b97473';
const EDRDG = 'https://www.edrdg.org/pub/Nihongo/';

const sha256 = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex');

async function download(url: string, dest: string): Promise<{ sha256: string; bytes: number; lastModified: string | null }> {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const part = dest + '.part';
  const hash = createHash('sha256');
  let bytes = 0;
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  body.on('data', (c: Buffer) => { hash.update(c); bytes += c.length; });
  await pipeline(body, createWriteStream(part));
  const expected = Number(res.headers.get('content-length'));
  if (expected && expected !== bytes) throw new Error(`${url}: got ${bytes} bytes, expected ${expected}`);
  renameSync(part, dest);
  return { sha256: hash.digest('hex'), bytes, lastModified: res.headers.get('last-modified') };
}

// Reads the start of a gzipped XML file and pulls the release date out with a regex.
async function dateInGzipHead(file: string, re: RegExp): Promise<string | null> {
  let head = '';
  const raw = createReadStream(file);
  const stream = raw.pipe(createGunzip());
  try {
    for await (const chunk of stream) {
      head += (chunk as Buffer).toString('utf8');
      const m = re.exec(head);
      if (m) return m[1] ?? null;
      if (head.length > 2_000_000) break;
    }
    return null;
  } finally {
    stream.destroy();
    raw.destroy();
  }
}

async function edrdg(name: string, re: RegExp): Promise<SourceRecord> {
  const url = EDRDG + name;
  const dest = join(staging, name);
  console.log(`fetching ${url}`);
  const d = await download(url, dest);
  const releaseDate = await dateInGzipHead(dest, re);
  if (!releaseDate) throw new Error(`${name}: no release date found in the file header`);
  return { file: name, url, sha256: d.sha256, bytes: d.bytes, releaseDate, lastModified: d.lastModified, fetchedAt: new Date().toISOString() };
}

interface PypiFile { filename: string; packagetype: string; url: string; digests: { sha256: string }; upload_time_iso_8601: string }

async function wordfreq(): Promise<SourceRecord> {
  const res = await fetch(`https://pypi.org/pypi/wordfreq/${WORDFREQ_VERSION}/json`, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok || !res.headers.get('content-type')?.includes('json')) throw new Error(`PyPI: HTTP ${res.status} ${res.headers.get('content-type')}`);
  const meta = (await res.json()) as { urls: PypiFile[] };
  const wheel = meta.urls.find((f) => f.packagetype === 'bdist_wheel');
  if (!wheel) throw new Error(`no wordfreq ${WORDFREQ_VERSION} wheel on PyPI`);
  if (!wheel.url.startsWith('https://files.pythonhosted.org/')) throw new Error(`unexpected wheel host: ${wheel.url}`);
  if (wheel.digests.sha256 !== WORDFREQ_WHEEL_SHA256) throw new Error(`PyPI lists wheel sha256 ${wheel.digests.sha256}, pinned ${WORDFREQ_WHEEL_SHA256}`);

  // The wheel goes into its own empty directory; only the one data file is copied out.
  const tmp = join(staging, '.wordfreq-wheel');
  mkdirSync(tmp);
  const wheelPath = join(tmp, wheel.filename);
  console.log(`fetching ${wheel.url}`);
  const d = await download(wheel.url, wheelPath);
  if (d.sha256 !== WORDFREQ_WHEEL_SHA256) throw new Error(`wordfreq wheel sha256 mismatch: ${d.sha256} vs pinned ${WORDFREQ_WHEEL_SHA256}`);

  const wanted = ['wordfreq/data/large_ja.msgpack.gz', 'wordfreq/data/small_ja.msgpack.gz'];
  const files = unzipSync(new Uint8Array(await readFile(wheelPath)), { filter: (f) => wanted.includes(f.name) });
  const member = wanted.find((w) => files[w]);
  if (!member) throw new Error('wordfreq wheel has no Japanese data file');
  if (member !== wanted[0]) console.warn(`warning: wheel has no ${wanted[0]}; using ${member}`);
  const data = files[member]!;
  const outName = member.split('/').at(-1)!;
  writeFileSync(join(staging, outName), data);
  rmSync(tmp, { recursive: true, force: true });

  return {
    file: outName, url: wheel.url, sha256: sha256(data), bytes: data.length,
    releaseDate: wheel.upload_time_iso_8601.slice(0, 10), lastModified: null, fetchedAt: new Date().toISOString(),
    version: WORDFREQ_VERSION, archive: { file: wheel.filename, sha256: d.sha256, member },
  };
}

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
const manifest: Manifest = {
  jmdict: await edrdg('JMdict_e.gz', /<!-- JMdict created: (\d{4}-\d{2}-\d{2}) -->/),
  kanjidic2: await edrdg('kanjidic2.xml.gz', /<date_of_creation>(\d{4}-\d{2}-\d{2})<\/date_of_creation>/),
  wordfreq: await wordfreq(),
};
for (const [k, r] of Object.entries(manifest)) console.log(`${k}: ${r.file} ${r.bytes} bytes, released ${r.releaseDate}, sha256 ${r.sha256}`);

if (verify) {
  if (!existsSync(manifestPath)) throw new Error('--verify: no sources/manifest.json to compare against');
  const committed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const bad = (Object.keys(manifest) as (keyof Manifest)[]).filter((k) => manifest[k].sha256 !== committed[k]?.sha256);
  if (bad.length) {
    for (const k of bad) console.error(`${k}: downloaded ${manifest[k].sha256}, manifest has ${committed[k]?.sha256} (released ${committed[k]?.releaseDate})`);
    console.error('The upstream files changed since the manifest was written (EDRDG only serves the latest release). Downloads left in sources/.staging.');
    process.exit(1);
  }
  console.log('verify: every download matches sources/manifest.json');
}

// Every download succeeded: move them in, then write the manifest last.
for (const r of Object.values(manifest)) renameSync(join(staging, r.file), join(sources, r.file));
if (!verify) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
rmSync(staging, { recursive: true, force: true });
