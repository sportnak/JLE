// reference.sqlite schema. Bump SCHEMA_VERSION on any change a reader would notice.
export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE entry (
  id        INTEGER PRIMARY KEY,   -- JMdict ent_seq
  written   TEXT NOT NULL,         -- first kanji form not sK/rK/oK (else first non-sK), or the reading
  reading   TEXT NOT NULL,         -- first reading valid for written
  kana_only INTEGER NOT NULL,      -- 1: no non-sK kanji form, every kanji form rK/oK, or first sense 'uk'
  freq_rank INTEGER,               -- 1 = most frequent; dense over ranked entries
  zipf      REAL,
  priority  TEXT NOT NULL,         -- ke_pri/re_pri tags, comma-joined
  pos       TEXT NOT NULL,         -- JSON: entity names of the first sense that applies to written/reading
  gloss     TEXT NOT NULL,         -- JSON: one short string per applicable sense, first 3 (stagk/stagr respected)
  jlpt      INTEGER
);

CREATE TABLE form (
  entry_id   INTEGER NOT NULL REFERENCES entry(id),
  idx        INTEGER NOT NULL,     -- order within its kind
  text       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('kanji', 'kana')),
  is_primary INTEGER NOT NULL,     -- 1 for entry.written and entry.reading
  info       TEXT,                 -- JSON: ke_inf/re_inf entity names, or NULL
  pri        TEXT,                 -- ke_pri/re_pri tags, comma-joined, or NULL
  restr      TEXT,                 -- kana only. JSON: kanji forms this reading is limited to; [] = re_nokanji; NULL = all
  PRIMARY KEY (entry_id, kind, idx)
) WITHOUT ROWID;

CREATE TABLE sense (
  entry_id INTEGER NOT NULL REFERENCES entry(id),
  idx      INTEGER NOT NULL,
  pos      TEXT NOT NULL,          -- JSON; inherited from the previous sense when omitted
  misc     TEXT,                   -- JSON or NULL
  field    TEXT,
  dial     TEXT,
  stagk    TEXT,                   -- JSON: kanji forms this sense is limited to, or NULL
  stagr    TEXT,
  info     TEXT,                   -- s_inf, '; '-joined, or NULL
  gloss    TEXT NOT NULL,          -- JSON array of English glosses
  PRIMARY KEY (entry_id, idx)
) WITHOUT ROWID;

CREATE TABLE tag (name TEXT PRIMARY KEY, description TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE kanji (
  literal  TEXT PRIMARY KEY,
  grade    INTEGER,
  jlpt_old INTEGER,
  freq     INTEGER,
  strokes  INTEGER,
  "on"     TEXT NOT NULL,          -- JSON
  kun      TEXT NOT NULL,          -- JSON
  meanings TEXT NOT NULL           -- JSON, English only
) WITHOUT ROWID;
`;

// Created after the bulk load.
export const INDEXES = `
CREATE INDEX entry_freq ON entry(freq_rank) WHERE freq_rank IS NOT NULL;
CREATE INDEX form_text ON form(text);
`;
