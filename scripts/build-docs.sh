#!/usr/bin/env bash
# scripts/build-docs.sh
#
# Concatenates every docs/context/journal/S<N>-<dev>.md fragment, in numeric
# session order, into docs/context/JOURNAL.md. Safe to run any number of
# times: with the same fragments in place, it produces the same output.
#
# Usage:
#   scripts/build-docs.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
JOURNAL_DIR="$REPO_ROOT/docs/context/journal"
OUTPUT_FILE="$REPO_ROOT/docs/context/JOURNAL.md"

if [ ! -d "$JOURNAL_DIR" ]; then
  echo "FAIL: journal directory not found at $JOURNAL_DIR" >&2
  exit 1
fi

# Collect fragment paths tagged with their numeric session number, so a sort
# by that number puts S9 before S10 (a plain filename sort would not).
FRAG_INDEX=""
while IFS= read -r -d '' FRAG_FILE; do
  FRAG_BASE="$(basename "$FRAG_FILE")"
  FRAG_NUM="$(printf '%s' "$FRAG_BASE" | grep -oiE '^S[0-9]+' | grep -oE '[0-9]+' || true)"
  if [ -n "$FRAG_NUM" ]; then
    FRAG_INDEX="$FRAG_INDEX$FRAG_NUM	$FRAG_FILE
"
  fi
done < <(find "$JOURNAL_DIR" -maxdepth 1 -type f -iname 'S[0-9]*.md' -print0 2>/dev/null)

FRAGMENT_COUNT=0
{
  echo "<!-- GENERATED FILE. Built by scripts/build-docs.sh. Do not hand-edit. -->"
  echo "<!-- Source: docs/context/journal/S<N>-<dev>.md fragments, in numeric session order. -->"
  echo ""
  echo "# Session Journal"
  echo ""
  if [ -z "$FRAG_INDEX" ]; then
    echo "_No journal fragments yet. See docs/context/journal/README.md._"
  else
    while IFS= read -r FRAG_PATH; do
      [ -z "$FRAG_PATH" ] && continue
      cat "$FRAG_PATH"
      echo ""
      FRAGMENT_COUNT=$((FRAGMENT_COUNT + 1))
    done < <(printf '%s' "$FRAG_INDEX" | sort -n -k1,1 | cut -f2-)
  fi
} > "$OUTPUT_FILE"

echo "Built $OUTPUT_FILE from $FRAGMENT_COUNT fragment(s)."
