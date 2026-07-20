---
name: wrap
description: Wrap up the current work session — run the gates, run the four-lens session review, update the continuity memory (without changing the session number), append the self-assessment + scorecard, sweep repo hygiene, open a close/docs PR off fresh master, verify prod, and produce a ready-to-paste handoff for the next session. NEVER auto-merges (a human gives the merge-go). Trigger — "/wrap", "wrap the session", "close out the session".
license: MIT
---

# Wrap Session

A repeatable session-close for the AI Quote Tool. It codifies the continuity close
protocol (`docs/context/README.md`) + the AGENTS.md rules. **It never merges to
master** — `master` auto-deploys to prod, so a human gives the merge-go (AGENTS.md
"Review / merge: an AI never merges on its own").

## Steps

1. **Pre-flight, then gates green.** First check `node_modules` exists; if missing,
   run `npm ci` (OneDrive eats it on this project's machines). Then run
   `npx tsc --noEmit` · `npm run lint` · `npm test` and confirm all three pass.
   If a gate fails on files another session or agent added, check `package.json`
   and run `npm install` FIRST before diagnosing a break (stale modules faked a
   "master is broken" incident in S42). If still red after that, surface it and
   stop: don't close out on a broken tree. (If the Bash tool is blocked, hand the
   dev a paste-able command sequence instead of stalling.)

2. **Session review (four lenses, standing order, Naldo 2026-07-20).** Review
   EVERYTHING the session shipped: the diff from the session's starting master SHA
   to current master, plus any branch still open at close. Spawn four review
   agents in parallel, in one message, each with an explicit model (Sonnet 5 per
   the routing table; never let a spawn inherit the session model). Lenses and
   brief shape: AGENTS.md "Review gates". Run it even when every PR was
   lens-reviewed at merge time; the combined tree can break in ways per-PR reviews
   miss. Disposition every finding: fix / accept with a stated reason / defer to a
   ledger row. HIGH findings on still-open work get fixed before the close PR;
   HIGH findings on already-merged work get a ledger row AND a direct flag to the
   dev. Findings feed Steps 3 and 4.

3. **Update the continuity memory — WITHOUT changing the session number.** One
   conversation = one session; read the current number from the logs and keep it
   fixed.
   - Append a session entry to **your OWN** log only — `docs/context/session_log.md`
     (Jason) or `session_log_naldo.md` (Naldo). Never edit the other dev's log.
     Include the session-review outcome (finding counts + dispositions).
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

4. **Self-assessment + scorecard (the mistakes log; runs EVERY close).**
   - Append a newest-on-top entry to the local memory file
     `~/.claude/projects/<project>/memory/feedback_self_assessment.md`, matching its
     format: **What I did** · **❌ Mistakes** (each with the lesson) · **✅ Did right**
     · **🎯 Habits to apply**. Local-only; it does NOT go in the docs PR. Be honest
     and specific. Session-review findings against your own work go in Mistakes.
   - Append this session's entry to the CLAUDE.md journal (the running scorecard +
     a short session block), same session number. The journal is what next session
     reads first, so the entry is the compounding step, not optional.
   - **Promotion pass:** any mistake now made TWICE across sessions gets promoted
     to AGENTS.md "Pitfalls" (single source), and once promoted it gets pruned from
     the running self-assessment habits list so the file stays lean (the archive
     keeps the full record).

5. **Repo hygiene sweep.** Rot compounds between sessions; sweep it every close.
   - `git status` for stray untracked files: surface each one to the dev
     (ship it / .gitignore it / delete it, the dev picks). Never silently commit or
     delete a file you didn't create.
   - `git worktree list` + local branches already merged to master: propose a prune
     list, prune on the dev's confirm. Never delete unmerged work.

6. **Commit + open a PR off FRESH master** (PR-not-master applies to docs too).
   - Fetch and branch in ONE command, e.g.
     `git fetch origin && git switch -c jason/sNN-close origin/master`. Never
     trust a fetch from earlier in the session (a stale base bit S42 and S43).
     The PR is then only your delta (git auto-merges non-overlapping edits;
     hand-resolve only a literal same-line clash).
   - Commit (end the message with the `Co-Authored-By: Claude …` line), push, open
     the PR with `gh`.
   - **🛑 STOP HERE. Surface the PR and WAIT for the dev's explicit "merge."** NEVER
     auto-merge — `master` → prod. On the dev's go: re-verify master is current
     ("always merge current"), bring the branch up to date + re-gate, then merge.

7. **Close-out verify.** If the session merged any CODE PR, verify prod actually
   serves it: one Vercel API call, latest READY deployment's SHA equals the current
   master tip (S25: a deploy can look READY and serve stale). A docs-only close
   needs no deploy check. Then sweep open PRs (`gh pr list --limit 200`) so the
   handoff carries the real open-PR state.

8. **Hand off.** Output a **ready-to-paste prompt for the next session**: the session
   number to use, master's state, open PRs, what's pending / next up, and any
   "do first" items (e.g. reseed local memory if master moved a lot, refresh the
   graph). Mirror the start-protocol shape the dev uses to begin a session.

9. **If work continues in the SAME conversation after this wrap:** the session
   number stays fixed. Append a POST-CLOSE delta to the SAME session entry (log +
   journal), and sync it with a mini docs PR under the same rules. Never bump the
   number, never write a new session block.

## Don't
- Don't auto-merge or auto-deploy — the human approves every merge.
- Don't bump the session number.
- Don't edit the other dev's session log.
- Don't skip the session review (Step 2) to save tokens; it is a standing order
  (Naldo 2026-07-20). Scale the agent count down only if the session shipped
  nothing at all (no diff = nothing to review; say so and move on).
