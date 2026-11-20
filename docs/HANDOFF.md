# Handoff: where the Japanese Learning Engine stands

Last updated 2026-11-20 (step 1c merged; first part of 1b done). Read this first when picking the project up on a new machine or in a new session. Read `docs/architecture.md` next: it is the design, and this file is the status.

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
| 1b | Full JMdict and KANJIDIC2 in `reference.sqlite`, a `Catalog` port, Sudachi tokenizer, sparse state at dictionary scale, frequency-band placement; retires the starter list | **Part done.** The `Catalog` port is in: the engine reaches items through lookups, word → kana edges are computed, and progress counts come from sparse state. A simulated learner gives a byte-identical log before and after. The rest is **blocked** on decisions 1 and 2 below. |
| 2 | Your own text (`addContent`) first, then generated reading, hinge questions, contrast choice, transformation, highlighting, sentence mining, grammar data and approval, model-call logging | Not started |
| 3 | Free writing, tutor conversation, situation prompts, role-play, retelling, error hunt | Not started |
| 4 | Fast track, disguised probes, full cold start, cluster advance | Not started |
| 5 | Graded listening, listen-read-listen, narrow reading, shadowing, fluency, timed retelling, weekly rollup, pinned goals | Not started |

## Open decisions

Step 2's activities are stage-2 activities, and stage 2 starts at 300 Known words; the starter list has 130. So step 2 can't reach a learner until 1b replaces the starter list, which makes decisions 1 and 2 the critical path.

1. **Item granularity:** one vocabulary item per JMdict entry (recommended: the tokenizer gives lemmas, not senses) or per sense?
2. **Downloads for 1b:** JMdict, KANJIDIC2, a Sudachi dictionary, and which word-frequency list. The list's licence matters if the app is ever distributed.
3. **Grammar approval:** who approves fact sheets, and where. Recommended: files in this repo, approved through review by someone who reads Japanese well.
4. **Grading model:** recommended to start on `claude-sonnet-5-5` and test a smaller model against a labelled set before switching.
5. **Distribution:** personal only, or might it ship? This decides the frequency-list licence and whether the API key eventually needs a backend.
6. **Genki in parallel:** should the planner follow the current textbook chapter?
7. **The 54 PRD suggestion cards** (29 from the amendment, 25 from Activities): accept or reject them in the PRD.

## Decisions made (do not reopen without a reason)

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

**Step 1b, once decisions 1 and 2 are made.** Follow `docs/architecture.md` §4.1 (Catalog port), §5.2 (reference database), §6.1 (Sudachi) and §11:
- Build `packages/reference` to produce `reference.sqlite` from JMdict, KANJIDIC2 and the chosen frequency list.
- Implement `Catalog` over `reference.sqlite` (the in-memory one is `memoryCatalog` in `packages/engine/src/catalog.ts`). Word → kanji edges join the computed word → kana ones.
- Page `Engine.clusterRows` and the progress table for dictionary-sized bands.
- Replace the starter-word bands with frequency-band placement.
- Add Sudachi in the Rust host.
- Keep the existing tests passing and the real log replaying.
