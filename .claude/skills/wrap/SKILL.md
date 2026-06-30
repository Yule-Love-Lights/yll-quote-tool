---
name: wrap
description: Wrap up the current work session — run the gates, update the continuity memory (without changing the session number), open a close/docs PR off fresh master, and produce a ready-to-paste handoff for the next session. NEVER auto-merges (a human gives the merge-go). Trigger — "/wrap", "wrap the session", "close out the session".
license: MIT
---

# Wrap Session

A repeatable session-close for the AI Quote Tool. It codifies the continuity close
protocol (`docs/context/README.md`) + the AGENTS.md rules. **It never merges to
master** — `master` auto-deploys to prod, so a human gives the merge-go (AGENTS.md
"Review / merge: an AI never merges on its own").

## Steps

1. **Gates green.** Run `npx tsc --noEmit` · `npm run lint` · `npm test` and confirm
   all three pass. If anything's red, surface it and stop — don't close out on a
   broken tree. (If the Bash tool is blocked, hand the dev a paste-able command
   sequence instead of stalling.)

2. **Update the continuity memory — WITHOUT changing the session number.** One
   conversation = one session; read the current number from the logs and keep it
   fixed.
   - Append a session entry to **your OWN** log only — `docs/context/session_log.md`
     (Jason) or `session_log_naldo.md` (Naldo). Never edit the other dev's log.
   - Update the unified docs as needed: `task_ledger.md` (mark shipped tasks ✅ + the
     Shipped session) and `project_quote_tool.md` (current state / next up). Read the
     giant ledger rows **surgically** (narrow ranges / `grep -o`).
   - **Keep the continuity docs lean — archive on cadence (runs EVERY close, so the dev
     never has to ask).** Move newly-✅ ledger rows `task_ledger.md` → `task_ledger_archive.md`;
     if your session log now holds > 3 sessions, move the oldest beyond the latest 3 →
     `session_log_archive.md` (your OWN log only); trim the CLAUDE.md self-review journal to
     the cumulative scorecard + latest ~2 sessions. Move content **byte-verbatim** (the
     archives are the full record). Then reseed local memory from `docs/context` so the next
     session boots lean.
   - Capture: what shipped, the ending state (master SHA + gate counts), confirmed
     decisions (so they aren't re-litigated), and any cross-dev heads-up (shared-file
     or other-area touches the other owner should know about).

3. **Commit + open a PR off FRESH master** (PR-not-master applies to docs too).
   - `git fetch`, branch your sync off the latest `origin/master` so the PR is only
     your delta (git auto-merges non-overlapping edits; hand-resolve only a literal
     same-line clash).
   - Commit (end the message with the `Co-Authored-By: Claude …` line), push, open
     the PR with `gh`.
   - **🛑 STOP HERE. Surface the PR and WAIT for the dev's explicit "merge."** NEVER
     auto-merge — `master` → prod. On the dev's go: re-verify master is current
     ("always merge current"), bring the branch up to date + re-gate, then merge.

4. **Hand off.** Output a **ready-to-paste prompt for the next session**: the session
   number to use, master's state, what's pending / next up, and any "do first" items
   (e.g. reseed local memory if master moved a lot, refresh the graph). Mirror the
   start-protocol shape the dev uses to begin a session.

## Don't
- Don't auto-merge or auto-deploy — the human approves every merge.
- Don't bump the session number.
- Don't edit the other dev's session log.
- Don't fire a heavy multi-agent review unless this session shipped customer-facing /
  risky work that wasn't already reviewed.
