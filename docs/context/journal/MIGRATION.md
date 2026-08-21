# Migrating the old session logs into fragments

## Status now

This PR adds the fragment system (`docs/context/journal/`, the build
script, the session scripts). It does not migrate any existing history.
EXECUTED 2026-08-21 (PR #865): fragments are authoritative, the old logs are
frozen with banners. Historical plan below. Before that PR merged, nothing read
`docs/context/JOURNAL.md` as a source of truth yet.

## Why wait

A migration like this should happen at a quiet moment: no open
`session-claim/*` branches, no in-flight close PRs, and PR #852 (which owns
everything under `.claude/`) already merged. Doing it while sessions are
live risks losing a line mid-write, which is the exact problem this system
exists to prevent.

## The switch-over steps, when Naldo says go

1. Confirm the quiet moment: `git branch -r | grep session-claim` is empty,
   and no PR is mid-review.
2. Back up both logs the same way the repo already backs up logs: copy
   `session_log.md` and `session_log_naldo.md` alongside
   `session_log_archive.md` and `session_log_naldo_archive.md`, so nothing
   is lost if the conversion has a bug.
3. Write a one-time conversion script that reads each log's own `S<N>`
   section headers and splits the log into per-session fragments
   (`S<N>-<dev>.md`), dropped into `docs/context/journal/`.
4. Run `scripts/build-docs.sh` and diff the resulting
   `docs/context/JOURNAL.md` against the two original logs. Confirm every
   session made it across before deleting anything.
5. Update the wrap skill (`.claude/skills/wrap`) so a session close writes
   straight to its own fragment instead of appending to
   `session_log.md` / `session_log_naldo.md`. This PR deliberately does not
   touch that skill: PR #852 owns everything under `.claude/` right now, so
   the wrap-skill update is its own PR, opened after #852 lands.
6. Update any other doc that points at `session_log.md` or
   `session_log_naldo.md` as the live source, to point at `JOURNAL.md`
   instead.
7. Once the fragment system has run clean for a few real sessions, mark the
   two original logs archived, the same way `session_log_archive.md` and
   `session_log_naldo_archive.md` already work, and stop writing to them.

## Rollback

If the fragment system causes problems after switch-over, stop calling
`scripts/build-docs.sh` and go back to appending to the two logs directly.
Nothing about this plan destroys the original logs, so stepping back costs
nothing but the sessions written as fragments in between (which still
exist as files and can be read by hand).
