# @jle/reference

Builds `out/reference.sqlite`, the read-only item catalog: every JMdict entry, every KANJIDIC2 character, and a frequency rank per entry from wordfreq. One vocabulary item is one JMdict **entry** (not one sense).

## Build

Node 24 or later (the build and the readers use the built-in `node:sqlite`).

```bash
pnpm --filter @jle/reference run fetch     # downloads into sources/ (gitignored), writes sources/manifest.json
pnpm --filter @jle/reference build:db      # writes out/reference.sqlite (gitignored), about 7 s
pnpm --filter @jle/reference test          # DB tests skip with a message when out/ has no DB
```

Use `run fetch`: plain `pnpm --filter … fetch` runs pnpm's own built-in `fetch` command, not this script.

`fetch` downloads:

| Source | From | Kept as |
|---|---|---|
| JMdict (English only) | `http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz` | `sources/JMdict_e.gz` |
| KANJIDIC2 | `http://ftp.edrdg.org/pub/Nihongo/kanjidic2.xml.gz` | `sources/kanjidic2.xml.gz` |
| wordfreq (latest 3.x wheel on PyPI) | `files.pythonhosted.org`, URL from `https://pypi.org/pypi/wordfreq/json` | `sources/large_ja.msgpack.gz` (falls back to `small_ja`) |

The manifest records each file's sha256, size, URL and release date (JMdict's `JMdict created` header, KANJIDIC2's `date_of_creation`, the wheel's PyPI upload date). The wheel is checked against PyPI's sha256, unpacked in memory, and only the one data file is written out; nothing downloaded is executed. EDRDG serves only plain HTTP, so the recorded sha256 is the integrity record for those two files.

## Schema (version 1, also in `PRAGMA user_version`)

| Table | Columns | Notes |
|---|---|---|
| `meta` | `key`, `value` | Schema version, build date, each source's file, release date and sha256, wordfreq version, counts, attribution text. |
| `entry` | `id` (= JMdict `ent_seq`), `written`, `reading`, `kana_only`, `freq_rank`, `zipf`, `priority`, `pos`, `gloss`, `jlpt` | `written`: first kanji form that is not search-only (`sK`), else the first reading. `reading`: first reading valid for `written` (respects `re_restr`, skips `re_nokanji` and search-only `sk`). `kana_only`: no real kanji form, or every kanji form is `rK`/`oK`, or the first sense is `uk`. `priority`: all `ke_pri`/`re_pri` tags, comma-joined. `pos`: JSON entity names of the first sense. `gloss`: JSON, one string per sense for the first 3 senses, up to 3 glosses each. `jlpt`: NULL for now. |
| `form` | `entry_id`, `idx`, `text`, `kind` (`kanji`/`kana`), `is_primary`, `info`, `pri`, `restr` | Every `k_ele` and `r_ele`. `is_primary` marks the forms that are `entry.written` and `entry.reading`. `info`: JSON `ke_inf`/`re_inf` names. `pri`: that form's priority tags. `restr` (kana only): JSON list of kanji forms the reading belongs to, `[]` for `re_nokanji`, NULL for all. |
| `sense` | `entry_id`, `idx`, `pos`, `misc`, `field`, `dial`, `stagk`, `stagr`, `info`, `gloss` | Every sense. `pos` is inherited from the previous sense when a sense omits it, as JMdict specifies. List columns are JSON or NULL. |
| `tag` | `name`, `description` | JMdict's entity names with their DTD text (`v5k` → "Godan verb with 'ku' ending"), for display. |
| `kanji` | `literal`, `grade`, `jlpt_old`, `freq`, `strokes`, `on`, `kun`, `meanings` | `on`/`kun`/`meanings` are JSON; meanings are English only. `strokes` is the first (accepted) count. |

Entity references (`&v5k;`, `&n;`, `&uk;`) are stored as their names, never the expanded text.

Indexes: `entry(freq_rank)` (partial, ranked rows), `form(text)`. Lookups by entry id use the primary keys (`form` and `sense` are keyed `(entry_id, …)`, so no separate `form(entry_id)` index is needed).

Changes from the original brief, and why: `form` gained `idx`, `pri` and `restr` (re_restr has to live somewhere, and the frequency step reads per-form tags); `sense` gained `field`, `dial`, `stagk`, `stagr`, `info` (cheap, and sense restrictions matter for display); the `tag` table was added.

## Frequency ranks

wordfreq's Japanese list holds surface tokens (text segmented by MeCab) in bins of one centibel; bin *i* is Zipf `9 − i/100`, stored as `entry.zipf`. Tokens are walked in list order. Tokens without kana or kanji (ASCII, digits, punctuation) are skipped. Each token picks **one** entry among those with a form spelled the same (compared after NFKC and lower-casing, as wordfreq stores them):

1. a **headword** match: the entry's `written` form, or its reading if the entry is kana-only and either has no real kanji form or that reading is itself marked common;
2. the matched form carries `ichi1`, `news1`, `spec1` or `gai1`;
3. some sense is a particle, auxiliary, copula or conjunction;
4. more senses;
5. lowest `ent_seq`.

A **pure-kana token only ranks an entry it is a headword of.** That entry takes the next rank if it has none; otherwise the token is spent (an entry keeps its best rank, and a token never falls through to a weaker homograph). Ranks are dense, `1..N`.

Why the extra rules beyond "primary form, then priority tags, then lowest ent_seq":

- `nfXX`/`news2` tags count a *string* in newspapers, so every homograph of a kana string shares them; they cannot choose between homographs. Lowest `ent_seq` alone gave する→刷る-style errors; sense count is a better last proxy.
- Without (3), いる went to 要る and なる to 生る (the auxiliary senses belong to 居る and 成る), and たい went to 鯛.
- Without the common-reading condition in (1), rare `uk` nouns took common kana: とき→鴇, ところ→野老, くる→佝僂.
- Without the pure-kana rule, MeCab's inflection stems ranked unrelated kanji words high: なく→泣く (#63), でし→弟子, しよ→賜与, ござい→五罪.

Known limits, inherent to a surface-token list:

- Verbs and adjectives rank lower than their real frequency: only the dictionary-form token counts (食べる Zipf 4.92, while the stem 食べ is 5.46 and goes unused).
- Stems that are also dictionary words still land on those words: あり→蟻, 見→見 (n-suf), 出来→出来 (n), 入れ, 出し, 受け.
- Compounds MeCab splits (映画館, 政治家, 〜的) are often unranked.
- 1,491 entries tagged `ichi1` or `news1` have no rank (mostly split compounds, and homographs whose shared spelling went to another entry, e.g. 畳 たたみ).

## Readers

`src/index.ts` exports `openReference(path?)`, `referenceReader(db)` with `entryById`, `byLemma(text, reading?)`, `byFrequency(fromRank, limit)`, `kanji(literal)`, `forms`, `senses`, `meta`, and the row types.

## Attribution (required wherever this data is shown or shipped)

- **JMdict and KANJIDIC2**: these files are the property of the [Electronic Dictionary Research and Development Group](https://www.edrdg.org/) and are used in conformance with the Group's [licence](https://www.edrdg.org/edrdg/licence.html) (Creative Commons Attribution-ShareAlike 4.0). The app must credit EDRDG and link to the licence; derived data (this database) falls under the same share-alike terms.
- **wordfreq** (Robyn Speer, https://github.com/rspeer/wordfreq; cite as Robyn Speer (2022), rspeer/wordfreq: v3.0, Zenodo): data files under CC BY-SA 4.0. Its Japanese list draws on Wikipedia, OpenSubtitles 2018 (via OPUS, credit OpenSubtitles), web text (Leeds Internet Corpus, ParaCrawl, OSCAR), Twitter and Reddit. wordfreq is no longer updated; 3.1.1 is the last release.

The same text is stored in `meta.attribution`.
