# @jle/reference

Builds `out/reference.sqlite`, the read-only item catalog: every JMdict entry, every KANJIDIC2 character, and a frequency rank per entry from wordfreq. One vocabulary item is one JMdict **entry** (not one sense).

## Build

Node 24 or later (the build and the readers use the built-in `node:sqlite`).

```bash
pnpm --filter @jle/reference run fetch     # downloads into sources/ (gitignored), rewrites sources/manifest.json (committed)
pnpm --filter @jle/reference run fetch:verify  # downloads and fails unless every sha256 matches the committed manifest
pnpm --filter @jle/reference build:db      # writes out/reference.sqlite (gitignored), about 7 s
pnpm --filter @jle/reference test          # DB tests skip with a message when out/ has no DB
```

Use `run fetch`: plain `pnpm --filter … fetch` runs pnpm's own built-in `fetch` command, not this script.

`fetch` downloads:

| Source | From | Kept as |
|---|---|---|
| JMdict (English only) | `https://www.edrdg.org/pub/Nihongo/JMdict_e.gz` | `sources/JMdict_e.gz` |
| KANJIDIC2 | `https://www.edrdg.org/pub/Nihongo/kanjidic2.xml.gz` | `sources/kanjidic2.xml.gz` |
| wordfreq 3.1.1 wheel (pinned, with its sha256) | `files.pythonhosted.org`, URL from `https://pypi.org/pypi/wordfreq/3.1.1/json` | `sources/large_ja.msgpack.gz` (falls back to `small_ja` with a warning) |

The manifest records each file's sha256, size, URL and release date (JMdict's `JMdict created` header, KANJIDIC2's `date_of_creation`, the wheel's PyPI upload date). It is committed, so git records which inputs a DB was built from. The wheel is checked against the pinned sha256, unpacked in memory, and only the one data file is written out; nothing downloaded is executed. All downloads go to `sources/.staging` first; files and manifest are replaced only after every download succeeds. `build:db` hashes each source and refuses to build if it does not match the manifest.

EDRDG serves only the current release (the `ftp.edrdg.org` host has no valid certificate, so `www.edrdg.org` is used). To rebuild an older DB exactly, keep a copy of its `.gz` files outside git; `fetch:verify` tells you when upstream has moved on.

## Schema (version 1, also in `PRAGMA user_version`)

| Table | Columns | Notes |
|---|---|---|
| `meta` | `key`, `value` | Schema version, build date, each source's file, release date and sha256, wordfreq version, counts, attribution text. |
| `entry` | `id` (= JMdict `ent_seq`), `written`, `reading`, `kana_only`, `freq_rank`, `zipf`, `priority`, `pos`, `gloss`, `jlpt` | `written`: first kanji form that is not search-only (`sK`), rare (`rK`) or outdated (`oK`); else the first non-`sK` kanji form; else the first reading. `reading`: first reading valid for `written` (respects `re_restr`, skips `re_nokanji` and search-only `sk`). `kana_only`: no real kanji form, or every kanji form is `rK`/`oK`, or the first sense is `uk`. `priority`: all `ke_pri`/`re_pri` tags, comma-joined. `pos`: JSON entity names of the first sense that applies to `written`/`reading` (senses limited by `stagk`/`stagr` to other forms are skipped). `gloss`: JSON, one string per applicable sense for the first 3, up to 3 glosses each. `jlpt`: NULL for now. |
| `form` | `entry_id`, `idx`, `text`, `kind` (`kanji`/`kana`), `is_primary`, `info`, `pri`, `restr` | Every `k_ele` and `r_ele`. `is_primary` marks the forms that are `entry.written` and `entry.reading`. `info`: JSON `ke_inf`/`re_inf` names. `pri`: that form's priority tags. `restr` (kana only): JSON list of kanji forms the reading belongs to, `[]` for `re_nokanji`, NULL for all. |
| `sense` | `entry_id`, `idx`, `pos`, `misc`, `field`, `dial`, `stagk`, `stagr`, `info`, `gloss` | Every sense. `pos` is inherited from the previous sense when a sense omits it, as JMdict specifies. List columns are JSON or NULL. |
| `tag` | `name`, `description` | JMdict's entity names with their DTD text (`v5k` → "Godan verb with 'ku' ending"), for display. |
| `kanji` | `literal`, `grade`, `jlpt_old`, `freq`, `strokes`, `on`, `kun`, `meanings` | `on`/`kun`/`meanings` are JSON; meanings are English only. `strokes` is the first (accepted) count. |

Entity references (`&v5k;`, `&n;`, `&uk;`) are stored as their names, never the expanded text.

Indexes: `entry(freq_rank)` (partial, ranked rows), `form(text)`. Lookups by entry id use the primary keys (`form` and `sense` are keyed `(entry_id, …)`, so no separate `form(entry_id)` index is needed).

Changes from the original brief, and why: `form` gained `idx`, `pri` and `restr` (re_restr has to live somewhere, and the frequency step reads per-form tags); `sense` gained `field`, `dial`, `stagk`, `stagr`, `info` (cheap, and sense restrictions matter for display); the `tag` table was added.

## Frequency ranks

wordfreq's Japanese list holds surface tokens (text segmented by MeCab) in bins of one centibel; bin *i* is Zipf `9 − i/100`, stored as `entry.zipf`. Tokens are walked in list order. Each token picks **one** entry among those with a form spelled the same (compared after NFKC and lower-casing, as wordfreq stores them). All of this is in `src/frequency.ts`, with fixture tests in `test/frequency.test.ts`.

Before matching:

- Tokens without kana or kanji (ASCII, digits, punctuation) and iteration marks (々, ヽ, ゝ…) are skipped.
- `TOKEN_FOLDS` (hand-reviewed) maps MeCab inflection pieces to the word they come from, or drops them: まし/ませ → ます, でし → です, だろ → だろう, でしょ → でしょう, でき → 出来る, あり → 有る, kanji stems 見/出来/入れ/出し/受け → the verb; いけ, かっ, とっ, なっ, き, せ, ろ… are dropped.
- `HOMOGRAPH_OVERRIDES` (hand-reviewed) fixes kanji spellings whose tags tie or mislead: 市 し, 心 こころ, 金 かね, 風 かぜ, 未 み, 位 い, 館 かん, 官 かん, 下手 へた, 数 かず, 角 かど, 実 じつ, 共 とも, and the lone kana お/ご → 御.

Each candidate gets a **tier**:

- 2: the entry's `written` form; or the reading of a kana-only entry, when that reading is marked common (for an entry with kanji) or the entry is tagged common or is a particle/auxiliary (for an entry with no kanji).
- 1: another kana spelling marked common, when the entry has no kanji (でしょう でしょ), has a `uk` sense (皆 みんな, 一杯 いっぱい, 所 ところ) or the spelling is katakana (烏賊 イカ); also the reading of an untagged kanji-less entry.
- 0: any other form. A pure-kana token never ranks a tier-0 candidate.

Then: higher tier; any of `ichi1`/`news1`/`spec1`/`gai1` on the matched form; a particle/auxiliary/copula/conjunction sense; `ichi1` on the matched form; more senses; lowest `ent_seq`.

Extra guards:

- A lone kana only ranks a particle or auxiliary (so き, せ, み, こ, ド, レ… rank nothing).
- An untagged content word does not take a spelling a commonly tagged entry also has (the kanji-less "please do" とき never takes 時's とき).

The chosen entry takes the next rank if it has none; otherwise the token is spent (an entry keeps its best rank, and a token never falls through to a weaker homograph). Ranks are dense, `1..N`. `JLE_RANK_LOG=1 pnpm --filter @jle/reference build:db` also writes `out/rank-log.tsv` (rank, token, entry id) for review.

Why these rules:

- `news1`/`news2` and `nfXX` come from counting a string in newspapers, and on shared spellings they often sit on the rarer homograph (下 もと has news1,nf07 while 下 した has only ichi1; 生る なる has news1,nf07, 成る news2,nf34). So only "any common tag" and `ichi1` (a word list) are used; the remaining wrong ties are overrides.
- Function words go before the `ichi1` check so いる → 居る (not 要る) and なる → 成る (not 生る); "any common tag" goes before them so the untagged particle こと does not take 事's こと.
- Hiragana spellings of ordinary kanji words are left out of tier 1 because, as MeCab tokens, they are almost always inflection pieces: おり (ており) → 折, やり → 槍, いき → 粋, しろ → 白, おけ → 桶 were all ranked before this rule.

Known limits, inherent to a surface-token list:

- Verbs and adjectives still rank lower than their real frequency when their stems are not folded (食べる Zipf 4.92, while the stem 食べ is 5.46 and goes unused). `TOKEN_FOLDS` only covers stems that were landing on the wrong entry.
- Compounds MeCab splits (映画館, 政治家, 〜的) are often unranked, as are some ambiguous interjections (おお, ほう, もち) that share a spelling with a tagged word.
- Overrides and folds were reviewed against the top ~3,000; further down, homograph choices are only as good as the tie-break.

## Readers

`src/index.ts` exports `openReference(path?)`, `referenceReader(db)` with `entryById`, `byLemma(text, reading?)`, `byFrequency(fromRank, limit)`, `kanji(literal)`, `forms`, `senses`, `meta`, and the row types.

## Attribution (required wherever this data is shown or shipped)

- **JMdict and KANJIDIC2**: these files are the property of the [Electronic Dictionary Research and Development Group](https://www.edrdg.org/) and are used in conformance with the Group's [licence](https://www.edrdg.org/edrdg/licence.html) (Creative Commons Attribution-ShareAlike 4.0). The app must credit EDRDG and link to the licence; derived data (this database) falls under the same share-alike terms.
- **wordfreq** (https://github.com/rspeer/wordfreq; cite as Robyn Speer. (2022). rspeer/wordfreq: v3.0 (v3.0.2). Zenodo. https://doi.org/10.5281/zenodo.7199437): data files under CC BY-SA 4.0. Its Japanese list draws on Wikipedia, OpenSubtitles 2018 (via OPUS, credit OpenSubtitles), web text (OSCAR), Twitter and Reddit. (wordfreq as a whole also credits the Leeds Internet Corpus and ParaCrawl, used for other languages.) wordfreq is no longer updated; 3.1.1 is the last release.

The same text is stored in `meta.attribution`.
