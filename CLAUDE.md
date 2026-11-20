# CLAUDE.md

## Desktop app in /Applications

The learner opens the app from Spotlight, so `/Applications/日本語.app` must always match the latest code on the main checkout's branch.

- After any change to the desktop app (engine, seed, sounds, UI or Rust host) is committed or merged on the branch the main checkout runs, run `pnpm app` from the main checkout. It builds a release bundle and replaces the copy in `/Applications`.
- Never install from a worktree. The script refuses unless `JLE_INSTALL_FROM_WORKTREE=1` is set, and that is only for when the user asks for a branch build.
- Reinstalling keeps learner data: the log lives in `~/Library/Application Support/app.jle.desktop/`, keyed by the bundle identifier, not inside the app.
- Report the installed branch and commit (the script prints both).
