#!/usr/bin/env bash
# scripts/session-open.sh
#
# Claims the next free session number across every dev machine, then creates
# a git worktree for it. Safe to run from any machine at any time, even if
# another session is opening at the same moment: the claim step uses a
# remote branch push as the race lock, so only one machine ever wins a given
# number.
#
# Usage:
#   scripts/session-open.sh              claim a number, open a naldo/s<N> worktree
#   scripts/session-open.sh -d jason      claim a number, open a jason/s<N> worktree
#   scripts/session-open.sh --dry-run     show what would happen, change nothing
#
# What it does not do: it does not touch AGENTS.md, CLAUDE.md, anything under
# .claude/, or the two session logs. It only reads them to find the next
# free number.
set -euo pipefail

DRY_RUN=false
DEV="naldo"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -d)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "FAIL: -d needs a value, for example: -d jason" >&2
        exit 1
      fi
      DEV="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage: scripts/session-open.sh [--dry-run] [-d <dev>]

  --dry-run   print what would happen. Claims nothing, creates no worktree.
  -d <dev>    dev name for the branch, default "naldo". Example: -d jason
  -h, --help  show this help
EOF
      exit 0
      ;;
    *)
      echo "FAIL: unknown argument '$1'. Use --dry-run, -d <dev>, or -h." >&2
      exit 1
      ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel)"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

GIT_DIR_RAW="$(git rev-parse --git-dir)"
GIT_COMMON_DIR_RAW="$(git rev-parse --git-common-dir)"
GIT_DIR_ABS="$(cd "$GIT_DIR_RAW" && pwd)"
GIT_COMMON_DIR_ABS="$(cd "$GIT_COMMON_DIR_RAW" && pwd)"

IS_MAIN_CHECKOUT=false
if [ "$GIT_DIR_ABS" = "$GIT_COMMON_DIR_ABS" ]; then
  IS_MAIN_CHECKOUT=true
fi

if [ "$IS_MAIN_CHECKOUT" = true ] && [ "$CURRENT_BRANCH" = "master" ]; then
  echo "FAIL: refusing to run from the main checkout while it is on master." >&2
  echo "Switch the main checkout off master, or run this from a worktree instead." >&2
  exit 1
fi

echo "Fetching origin..."
if ! git fetch origin --prune; then
  echo "FAIL: git fetch origin failed. Check your network and try again." >&2
  exit 1
fi

echo "Scanning for existing session numbers..."

ALL_NUMBERS=""

# 1. journal fragments: docs/context/journal/S<N>-<dev>.md
JOURNAL_DIR="$REPO_ROOT/docs/context/journal"
if [ -d "$JOURNAL_DIR" ]; then
  while IFS= read -r -d '' FRAG_FILE; do
    FRAG_BASE="$(basename "$FRAG_FILE")"
    FRAG_NUM="$(printf '%s' "$FRAG_BASE" | grep -oiE '^S[0-9]+' | grep -oE '[0-9]+' || true)"
    if [ -n "$FRAG_NUM" ]; then
      ALL_NUMBERS="$ALL_NUMBERS
$FRAG_NUM"
    fi
  done < <(find "$JOURNAL_DIR" -maxdepth 1 -type f -iname 'S[0-9]*.md' -print0 2>/dev/null)
fi

# 2. both session logs, read-only, never edited by this script
for LOG in "$REPO_ROOT/docs/context/session_log.md" "$REPO_ROOT/docs/context/session_log_naldo.md"; do
  if [ -f "$LOG" ]; then
    LOG_NUMS="$(grep -oiE '\bS[0-9]+\b' "$LOG" | grep -oE '[0-9]+' || true)"
    if [ -n "$LOG_NUMS" ]; then
      ALL_NUMBERS="$ALL_NUMBERS
$LOG_NUMS"
    fi
  fi
done

# 3. open PRs (title and branch name)
if command -v gh >/dev/null 2>&1; then
  PR_JSON="$(gh pr list --limit 200 --state open --json headRefName,title 2>/dev/null || true)"
  if [ -n "$PR_JSON" ]; then
    PR_NUMS="$(printf '%s' "$PR_JSON" | grep -oiE '\bs[0-9]+\b' | grep -oE '[0-9]+' || true)"
    if [ -n "$PR_NUMS" ]; then
      ALL_NUMBERS="$ALL_NUMBERS
$PR_NUMS"
    fi
  fi
else
  echo "NOTE: gh not found on PATH, skipping the open-PR scan. The claim push still protects against a number collision."
fi

# 4. remote branches
BRANCH_NUMS="$(git branch -r 2>/dev/null | grep -oiE '\bs[0-9]+\b' | grep -oE '[0-9]+' || true)"
if [ -n "$BRANCH_NUMS" ]; then
  ALL_NUMBERS="$ALL_NUMBERS
$BRANCH_NUMS"
fi

MAX_NUM=0
while IFS= read -r NUM; do
  [ -z "$NUM" ] && continue
  if [ "$NUM" -gt "$MAX_NUM" ]; then
    MAX_NUM="$NUM"
  fi
done <<EOF
$ALL_NUMBERS
EOF

NEXT_NUM=$((MAX_NUM + 1))
echo "Highest session number found across all sources: S$MAX_NUM"
echo "Next candidate: S$NEXT_NUM"

if [ "$DRY_RUN" = true ]; then
  CLAIM_BRANCH="session-claim/s${NEXT_NUM}"
  BRANCH_NAME="${DEV}/s${NEXT_NUM}"
  WORKTREE_PATH="$(dirname "$REPO_ROOT")/wt-s${NEXT_NUM}"
  echo ""
  echo "DRY RUN, nothing was changed. If this were a real run, it would:"
  echo "  1. push an empty commit to origin/$CLAIM_BRANCH to claim S$NEXT_NUM"
  echo "     (retrying with the next number, up to 5 times, if that push loses a race)"
  echo "  2. create a worktree at $WORKTREE_PATH on branch $BRANCH_NAME"
  echo "  3. write $WORKTREE_PATH/.session-id containing: s${NEXT_NUM}"
  exit 0
fi

EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
HEAD_SHA="$(git rev-parse HEAD)"

TRIES=0
CLAIMED=false
CLAIM_BRANCH=""
while [ "$TRIES" -lt 5 ]; do
  TRIES=$((TRIES + 1))
  CLAIM_BRANCH="session-claim/s${NEXT_NUM}"
  CLAIM_SHA="$(git commit-tree "$EMPTY_TREE" -p "$HEAD_SHA" -m "claim: s${NEXT_NUM}")"
  echo "Attempt $TRIES of 5: claiming S$NEXT_NUM via origin/$CLAIM_BRANCH..."
  if git push origin "${CLAIM_SHA}:refs/heads/${CLAIM_BRANCH}"; then
    CLAIMED=true
    break
  fi
  echo "S$NEXT_NUM was just claimed by another session. Trying S$((NEXT_NUM + 1))..."
  NEXT_NUM=$((NEXT_NUM + 1))
done

if [ "$CLAIMED" != true ]; then
  echo "FAIL: could not claim a session number after 5 tries." >&2
  echo "Another session is very likely opening at the same time. Wait a moment and re-run scripts/session-open.sh." >&2
  exit 1
fi

BRANCH_NAME="${DEV}/s${NEXT_NUM}"
WORKTREE_PATH="$(dirname "$REPO_ROOT")/wt-s${NEXT_NUM}"

if [ -e "$WORKTREE_PATH" ]; then
  echo "FAIL: $WORKTREE_PATH already exists." >&2
  echo "The claim on origin/$CLAIM_BRANCH is still in place. Clean up the old path (or run 'git worktree prune'), then re-run." >&2
  exit 1
fi

echo "Creating worktree at $WORKTREE_PATH on branch $BRANCH_NAME..."
if ! git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" origin/master; then
  echo "FAIL: git worktree add failed." >&2
  echo "The claim on origin/$CLAIM_BRANCH is still in place, so S$NEXT_NUM is still yours. Fix the problem above and create the worktree by hand:" >&2
  echo "  git worktree add \"$WORKTREE_PATH\" -b \"$BRANCH_NAME\" origin/master" >&2
  exit 1
fi

echo "s${NEXT_NUM}" > "$WORKTREE_PATH/.session-id"

echo ""
echo "Session S$NEXT_NUM is open."
echo "Worktree: $WORKTREE_PATH"
echo "Branch: $BRANCH_NAME"
echo "Claim branch: origin/$CLAIM_BRANCH (scripts/session-close.sh removes this when you close the session)"
echo "Journal fragment for this session: docs/context/journal/s${NEXT_NUM}-${DEV}.md (see docs/context/journal/README.md)"
