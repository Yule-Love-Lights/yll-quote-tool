#!/usr/bin/env bash
# scripts/session-preflight.sh
#
# The check a wrap flow (or a human) can call before trusting a session
# worktree. Prints one PASS or FAIL line per check, then a RESULT line.
# Exits 0 only if every check passed.
#
# Usage:
#   scripts/session-preflight.sh
set -euo pipefail

OVERALL_PASS=true

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; OVERALL_PASS=false; }

if ! GIT_DIR_RAW="$(git rev-parse --git-dir 2>/dev/null)"; then
  fail "not inside a git repository"
  echo "RESULT: FAIL"
  exit 1
fi

GIT_COMMON_DIR_RAW="$(git rev-parse --git-common-dir)"
GIT_DIR_ABS="$(cd "$GIT_DIR_RAW" && pwd)"
GIT_COMMON_DIR_ABS="$(cd "$GIT_COMMON_DIR_RAW" && pwd)"

if [ "$GIT_DIR_ABS" = "$GIT_COMMON_DIR_ABS" ]; then
  fail "current directory is the main checkout, not a session worktree"
else
  pass "current directory is a session worktree"
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
SESSION_ID_FILE="$REPO_ROOT/.session-id"

if [ ! -f "$SESSION_ID_FILE" ]; then
  fail ".session-id file not found at $SESSION_ID_FILE"
else
  SESSION_ID="$(tr -d '[:space:]' < "$SESSION_ID_FILE" | tr '[:upper:]' '[:lower:]')"
  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  BRANCH_SESSION_ID=""
  if MATCH="$(printf '%s' "$CURRENT_BRANCH" | grep -oiE 's[0-9]+$')"; then
    BRANCH_SESSION_ID="$(printf '%s' "$MATCH" | tr '[:upper:]' '[:lower:]')"
  fi
  if [ -z "$BRANCH_SESSION_ID" ]; then
    fail "current branch '$CURRENT_BRANCH' does not end in s<N>"
  elif [ "$SESSION_ID" != "$BRANCH_SESSION_ID" ]; then
    fail ".session-id says '$SESSION_ID' but branch '$CURRENT_BRANCH' implies '$BRANCH_SESSION_ID'"
  else
    pass ".session-id ($SESSION_ID) matches branch ($CURRENT_BRANCH)"
  fi
fi

if [ "$OVERALL_PASS" = true ]; then
  echo "RESULT: PASS"
  exit 0
else
  echo "RESULT: FAIL"
  exit 1
fi
