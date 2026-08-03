#!/usr/bin/env bash
# Install the built plugin into an Obsidian vault for local testing.
#
#   ./install-to-vault.sh /path/to/vault
#
# Copies main.js + manifest.json + styles.css into
# <vault>/.obsidian/plugins/obsync/. The plugin is built first if main.js is
# missing or stale (it is gitignored).

set -euo pipefail
cd "$(dirname "$0")"

VAULT="${1:-}"
if [ -z "$VAULT" ]; then
  echo "usage: $0 /path/to/obsidian-vault" >&2
  exit 1
fi
if [ ! -d "$VAULT" ]; then
  echo "error: vault directory not found: $VAULT" >&2
  exit 1
fi

if [ ! -f main.js ] || [ main.ts -nt main.js ]; then
  echo "building plugin…"
  npm run build
fi

DEST="$VAULT/.obsidian/plugins/obsync"
mkdir -p "$DEST"
cp main.js manifest.json styles.css "$DEST/"
echo "installed to $DEST"
echo
echo "In Obsidian: Settings → Community plugins → enable Obsync."
echo "Desktop: Settings → Obsync → Start server."
echo "Mobile:  Settings → Obsync → set server URL → Sync now."
