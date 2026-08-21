#!/usr/bin/env bash
# scripts/session-close.sh
#
# Run from inside a session worktree (one created by scripts/session-open.sh).
# Rebases the session branch onto the latest origin/master and rebuilds
# docs/context/JOURNAL.md, then prints the exact command to open the close
# PR. It does not create or merge that PR: a human-gated wrap flow owns that
# step.
#
# Usage:
#   scripts/session-close.sh
set -euo pipefail

GIT_DIR_RAW="$(git rev-parse --git-dir)"
GIT_COMMON_DIR_RAW="$(git rev-parse --git-common-dir)"
GIT_DIR_ABS="$(cd "$GIT_DIR_RAW" && pwd)"
GIT_COMMON_DIR_ABS="$(cd "$GIT_COMMON_DIR_RAW" && pwd)"

if [ "$GIT_DIR_ABS" = "$GIT_COMMON_DIR_ABS" ]; then
  echo "FAIL: this is the main checkout, not a session worktree." >&2
  echo "Run scripts/session-close.sh from inside a worktree created by scripts/session-open.sh." >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
SESSION_ID_FILE="$REPO_ROOT/.session-id"

if [ ! -f "$SESSION_ID_FILE" ]; then
  echo "FAIL: .session-id not found at $SESSION_ID_FILE." >&2
  echo "This worktree was not created by scripts/session-open.sh, or the file was removed." >&2
  exit 1
fi

SESSION_ID="$(tr -d '[:space:]' < "$SESSION_ID_FILE" | tr '[:upper:]' '[:lower:]')"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

BRANCH_SESSION_ID=""
if MATCH="$(printf '%s' "$CURRENT_BRANCH" | grep -oiE 's[0-9]+$')"; then
  BRANCH_SESSION_ID="$(printf '%s' "$MATCH" | tr '[:upper:]' '[:lower:]')"
fi

if [ -z "$BRANCH_SESSION_ID" ]; then
  echo "FAIL: current branch '$CURRENT_BRANCH' does not end in s<N>." >&2
  echo "Expected something like naldo/s63 or jason/s63." >&2
  exit 1
fi

if [ "$SESSION_ID" != "$BRANCH_SESSION_ID" ]; then
  echo "FAIL: .session-id says '$SESSION_ID' but branch '$CURRENT_BRANCH' implies '$BRANCH_SESSION_ID'." >&2
  echo "These must match. Fix whichever one is wrong before closing." >&2
  exit 1
fi

echo "Worktree check passed: branch $CURRENT_BRANCH, session $SESSION_ID."

echo "Fetching origin..."
if ! git fetch origin; then
  echo "FAIL: git fetch origin failed. Check your network and try again." >&2
  exit 1
fi

echo "Rebasing $CURRENT_BRANCH onto origin/master..."
if ! git rebase origin/master; then
  echo "FAIL: the rebase hit a conflict." >&2
  echo "Resolve the files git status shows, then run 'git rebase --continue'." >&2
  echo "Or run 'git rebase --abort' to back out. Re-run scripts/session-close.sh once the rebase is clean." >&2
  exit 1
fi

BUILD_DOCS="$REPO_ROOT/scripts/build-docs.sh"
if [ ! -f "$BUILD_DOCS" ]; then
  echo "FAIL: scripts/build-docs.sh not found at $BUILD_DOCS." >&2
  exit 1
fi

echo "Running scripts/build-docs.sh..."
if ! bash "$BUILD_DOCS"; then
  echo "FAIL: build-docs.sh failed. Fix the error above and re-run scripts/session-close.sh." >&2
  exit 1
fi

CLAIM_BRANCH="session-claim/${SESSION_ID}"
echo "Removing remote claim branch origin/$CLAIM_BRANCH (it did its job)..."
if git ls-remote --exit-code --heads origin "$CLAIM_BRANCH" >/dev/null 2>&1; then
  if git push origin --delete "$CLAIM_BRANCH"; then
    echo "Deleted origin/$CLAIM_BRANCH."
  else
    echo "WARN: could not delete origin/$CLAIM_BRANCH. Delete it by hand later:" >&2
    echo "  git push origin --delete $CLAIM_BRANCH" >&2
  fi
else
  echo "No remote claim branch origin/$CLAIM_BRANCH found (already gone, that's fine)."
fi

echo ""
echo "Session $SESSION_ID is rebased and its docs are built."
echo "This script does not create or merge a PR. A human-gated wrap flow owns that."
echo "To open the close PR yourself, run:"
echo ""
echo "  gh pr create --base master --head $CURRENT_BRANCH --title \"docs(${SESSION_ID}): close\" --body \"Session ${SESSION_ID} close.\""
echo ""
