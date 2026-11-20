#!/bin/sh
# Builds the desktop app and replaces the copy in /Applications, so Spotlight always opens the current build.
# Refuses to run from a git worktree: /Applications holds the app you study with, so only the main checkout installs.
set -eu
cd "$(dirname "$0")/.."

if [ "$(git rev-parse --path-format=absolute --git-dir)" != "$(git rev-parse --path-format=absolute --git-common-dir)" ] && [ "${JLE_INSTALL_FROM_WORKTREE:-}" != "1" ]; then
  echo "Not installing from a worktree. Run this from the main checkout, or set JLE_INSTALL_FROM_WORKTREE=1." >&2
  exit 1
fi

# The dictionary is bundled into the app (src-tauri/tauri.conf.json resources); build it first if it is missing.
if [ ! -f ../../packages/reference/out/reference.sqlite ]; then
  (cd ../.. && pnpm --filter @jle/reference run fetch && pnpm --filter @jle/reference build:db)
fi

name=$(node -p "require('./src-tauri/tauri.conf.json').productName")
pnpm tauri build --bundles app

src="src-tauri/target/release/bundle/macos/$name.app"
dest="/Applications/$name.app"
rm -rf "$dest"
ditto "$src" "$dest"
mdimport "$dest" 2>/dev/null || true
echo "Installed $dest from $(git branch --show-current) at $(git rev-parse --short HEAD)"
