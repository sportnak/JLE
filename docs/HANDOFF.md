# Handoff: where the Japanese Learning Engine stands

Last updated 2026-11-20 (step 1b: dictionary, Sudachi and the activity demo page). Read this first when picking the project up on a new machine or in a new session. Read `docs/architecture.md` next: it is the design, and this file is the status.

## The documents

All three are Claude artifacts, private to the owner's Claude account. Sign in to open them.

| Document | What it holds | Link |
|---|---|---|
| PRD | The engine's product requirements, plus the amendments: items from the dictionary, grammar as data, your own content, model use, and the expanded activities. **54 suggestion cards are waiting for review** in it. | https://claude.ai/artifact/1J3DyYfFoQAewzP7hDSUtA |
| Design system | Tokens, components and copy rules (Paper and Night themes, no romaji, flat tone). Vendored into `apps/desktop/src/design/`. | https://claude.ai/artifact/Dw8bCXfz1Zuxe7jXi71tj4 |
| Wireframe | Six phone screens: Today, reading with a hinge question, "Which part?", tutor conversation, Recap, Progress. | https://claude.ai/artifact/C9wScQzKrZ2GzM2RhkMPeF |

## Branches

| Branch | State |
|---|---|
| `michael/step-1-foundation` | The main branch. Steps 1 and 1c, plus the first, decision-free part of 1b. This is what `/Applications/日本語.app` is built from. |
| `claude/step-1c-activities-61b271` | Merged; can be deleted. |

## Status by build step

| Step | Contents | State |
|---|---|---|
| 1 | Event log and replay, evidence rules, FSRS-7, placement, planner (rests correct items, teaches misses back, adaptive intake, interleaving, early end), kana and a 130-word starter list, closed-answer grading including inflected forms, credited session clock, Tauri app, SQLite log, VOICEVOX voice with picker and speed, design system, font choice, in-lesson settings | **Done** |
| 1c | Activity registry, stage-based mix with a closed-exercise cap, minimal-pair listening, dictation, `packages/sounds` | **Done.** Every screen checked at phone and desktop width. Also fixed: items missed again after teaching were never served again; after a study-heavy week, missed dictations filled sessions (strand balance now blends in the current session). |
| 1b | Full JMdict and KANJIDIC2 in `reference.sqlite`, a `Catalog` port, Sudachi tokenizer, sparse state at dictionary scale, frequency-band placement; retires the starter list | **Done except kanji items.** `packages/reference` builds `reference.sqlite` (JMdict, KANJIDIC2, wordfreq) and exports the app's word list: the 130 starter words, then the 20,000 most frequent content words in bands of 100. Old `vocab:` ids map to `jmdict:` ids on replay. Placement probes far down the list but only teaches near the frontier. Sudachi runs in the host behind `analyze`. Kanji items and word → kanji edges wait until kanji are taught. |
| 2 | Generated reading first (decided 2026-11-20), then your own text, hinge questions, contrast choice, transformation, highlighting, sentence mining, grammar data and approval | **Generated reading built.** A lesson includes one short passage written by `claude-opus-5-5` for your level, checked in code (coverage, new words, target words, retries) and stored once. Read it with furigana on unfamiliar words; tapping a word looks it up (a weak miss) and queues it to be taught. Every generated passage is also reviewed by `claude-sonnet-5-5` (natural Japanese, matching English) and rewritten if it fails. Offline or without a key, the best-fitting of 60 built-in passages (`packages/seed/src/passages.ts`, levels 1–6, about N5 to N4) is used instead; passages read 3+ days ago come back to be reread. After each passage, one or two multiple-choice questions (a hinge on one word gives it recognition evidence). **Transformation** (make a form of a known word, graded by the conjugator) from stage 2. **Your own text** (Today → Add something of your own): split into parts, read in order in lessons ahead of other passages. **Highlighting**: words read in fewer than three passages are marked. **Sentence mining**: keep sentences after reading; a kept sentence becomes a cloze cue when one of its words is due for production (list and removal in Progress). **Grammar** as reviewed files in `packages/grammar` (16 Genki I points, all drafts: nothing reaches the learner until someone who reads Japanese approves them; see its README). **Contrast choice** (stage 2) on approved points, with the approved fact sheet after a wrong choice. Grammar is found in passages by each point's matcher at read time (approved points only; a passage using a point already met credits it lightly), and a wrong contrast choice can be explained by the model from the approved fact sheet, stored once per mistake. **Step 2 is complete** apart from approving the grammar drafts. |
| 3 | Free writing (model-graded, with the grading contract), tutor conversation, situation prompts, role-play, retelling, error hunt | Not started |
| 4 | Fast track, disguised probes, full cold start, cluster advance | Not started |
| 5 | Graded listening, listen-read-listen, narrow reading, shadowing, fluency, timed retelling, weekly rollup, pinned goals | Not started |

## Open decisions

1. **Who reviews the grammar drafts:** the 16 points in `packages/grammar` are drafts until someone who reads Japanese well approves them (`pnpm --filter @jle/grammar status`).
2. **Grading model:** recommended to start on `claude-sonnet-5-5` and test a smaller model against a labelled set before switching.
3. **Distribution:** personal only, or might it ship? This decides the frequency-list licence and whether the API key eventually needs a backend.
4. **Genki in parallel:** should the planner follow the current textbook chapter?
5. **The 54 PRD suggestion cards** (29 from the amendment, 25 from Activities): accept or reject them in the PRD.

## Decisions made (do not reopen without a reason)

- **Grammar approval (2026-11-21):** grammar points are files in this repo, approved by a reviewed edit (`approvedBy`, `approvedAt`) from someone who reads Japanese well. The catalog drops drafts, so they never reach the learner.
- **Reading (2026-11-20):** generated reading comes before your own text. Every generated passage is reviewed by a second model for now (the architecture's conditional review can come later). Offline mode uses a built-in library written in this repo, chosen per learner by coverage, so no outside text licences are involved. Words looked up are taught ahead of frequency order. The full dictionary ships inside the app (`pnpm app` builds it on first run: a ~13 MB download). Lookup = weak recognition miss (0.3); reading past a word already met = weak recognition evidence (0.2), with no review scheduled.
- **Items from the dictionary (2026-11-20):** one vocabulary item per JMdict entry, id `jmdict:<ent_seq>`. Frequency from wordfreq (CC BY-SA 4.0). The engine loads a generated word list (top 20,000 content words) into memory rather than querying the database; rarer words will come from the host. The starter list's `vocab:<written>` ids map to entries on replay; the log is never rewritten.

- **Stack:** Tauri 2 with a React and TypeScript UI; the engine is a pure TypeScript library; the Rust host does all I/O. Desktop first, mobile from the same code later.
- **LLM:** the Claude API with the owner's key, called from the Rust host, for five jobs only (generate, grade free writing, tutor, explain from approved fact sheets, review). Closed answers are graded in code. Learner state never lives in the model, and the known-word list is never sent to it.
- **Items:** the full dictionary as reference data, with learner state created on first meeting. Grammar points are versioned data, approved before use.
- **Kana** are shown and heard before they're attempted; everything else is attempted first. A miss on an unseen item is not a lapse.
- **Interleaving:** at most three of one item type in a row; the kana stage is exempt and mixes hiragana and katakana groups.
- **Sound features:** vowel length and small っ are tracked with minimal pairs; pitch accent is exposure-only.
- **Timed retelling** waits for voice input.
- **No romaji is ever shown.** Typed romaji converts to kana on "In Japanese" prompts only; kana prompts don't convert, so you can't type until it matches.
- **Voice:** VOICEVOX locally for lesson audio (readings forced by passing kana), a cloud voice later for stories and conversation. Kyoko is the fallback. Default voice 四国めたん (ノーマル); credit "VOICEVOX:<name>" shown in Settings.
- **Font:** chosen per device in Settings; Klee One (textbook pen style) recommended for studied Japanese, Gothic for small text, Shippori Mincho for titles.
- **Session clock:** each prompt has an expected time; finishing faster moves the timer forward, so a session is a fixed amount of work.
- **Process:** no AI references in commits or PRs; real git identity; keep code comments short; ask why before unsettled product choices.

## Setting up on another Mac

```bash
git clone https://github.com/sportnak/JLE.git && cd JLE
git checkout michael/step-1-foundation   # or the step-1c branch to continue it
```

Needs Node 22.12+ (24 works; Node 18 fails to load Vite 8's native bindings), pnpm 10+, Rust (install with `rustup`; make sure `~/.cargo/bin` is on PATH), and Xcode command-line tools. If tests fail to start with a missing `@rolldown/binding-*`, run `pnpm install --force` under the newer Node.

```bash
pnpm install
pnpm -r test && pnpm -r typecheck
cd apps/desktop && pnpm tauri dev
```

`pnpm dev` from the repo root runs the UI in a browser instead, with the log kept in browser storage and without VOICEVOX.

**VOICEVOX (lesson voice).** Download the official engine from the VOICEVOX/voicevox_engine GitHub releases: on Apple Silicon `voicevox_engine-macos-arm64-<version>.vvpp` (about 2 GB, a zip), on Intel the x64 build. Unzip it into `~/Library/Application Support/jle-voicevox/<version>/`, so that `.../<version>/run` exists. The app finds the newest version there, starts the engine on 127.0.0.1:50021 and stops it on quit. `JLE_VOICEVOX_DIR` overrides the folder. Without it, the app uses the system voice.

**Sudachi (tokenizer).** Download `sudachi-dictionary-<date>-core.zip` (about 77 MB) from the WorksApplications/SudachiDict GitHub releases and put its `system_core.dic` (about 200 MB) in `~/Library/Application Support/jle-sudachi/<date>/`. The host loads the newest one on first use (about 0.15 s) and keeps it; `JLE_SUDACHI_DIR` overrides the folder. The dictionary and sudachi.rs are Apache 2.0. Without it, the `analyze` command returns an error saying what to install. Tokenizer tests skip when it is missing.

**Your study progress** lives in `~/Library/Application Support/app.jle.desktop/jle.sqlite` and does not sync. To carry it over, quit the app on both machines and copy that file to the same path on the new Mac. Settings → Save a copy exports the log as JSON, but there is no import yet.

**Installing into /Applications:** `pnpm app` from the main checkout builds a release and replaces `/Applications/日本語.app`. See the repo `CLAUDE.md`.

## Briefs to start the next work

**Rebuilding the word list.** `pnpm --filter @jle/reference fetch`, then `build:db`, then `node packages/reference/scripts/slice.ts` (Node 24). The result, `packages/seed/src/data/words.json`, is committed so the app builds without the downloads.

**Step 2, next.** Your own text (`addContent`) reuses the reading pipeline without the generate step: tokenize with `analyze`, map with `mapTokens`, store with `source: 'learner'`. Then hinge questions on passages (comprehension, model-written, code-checked), contrast choice and transformation. See `docs/architecture.md` §6 and `packages/engine/src/content/reading.ts`.
