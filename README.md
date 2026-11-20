# Japanese Learning Engine

A single-learner Japanese tutor. One continuous loop: every activity both teaches and measures, and an append-only event log is the source of truth for everything the app knows about you.

- `packages/engine`: the engine, pure TypeScript with no I/O (learner model, evidence, FSRS scheduling, placement, planner, grading)
- `packages/seed`: kana tables and a starter vocabulary
- `apps/desktop`: Tauri 2 desktop app (React UI, Rust host with SQLite and VOICEVOX speech)
- `docs/architecture.md`: the design
- `docs/HANDOFF.md`: current status, decisions, open questions, setup and next steps

```bash
pnpm install
pnpm -r test
cd apps/desktop && pnpm tauri dev
```

See `docs/HANDOFF.md` for full setup, including the VOICEVOX voice engine.
