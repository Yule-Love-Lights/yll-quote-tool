### S70 (Naldo) — 2026-08-24 — office staff onboarding, then the panel rebuild it turned into: 4 PRs merged and live, 1 open. Close PR naldo/s70-close

> **SESSION NUMBER: this conversation began as S67** (the S66 handoff said so) and renumbered to **S70** at close. While it ran, three genuinely different sessions claimed and MERGED S67 (fleet GPS / Bouncie), S68 (self-serve estimator verification) and S69 (open-PR backlog cleanup). Merged claims win, so this one moved rather than colliding. Master went 244 commits between session start (`94ea2c0b`) and close (`caaa2c12`), which is the real reason: this was a long conversation in a fast repo.

**The ask.** Setting up an office person for the time clock meant hand-editing the database. End that. It grew, on Naldo's live feedback, into replacing the whole staff-admin surface.

**SHIPPED, merged and live:**
- **#906** — office-staff onboarding UI (row 354). Settings flow: pick an existing operator, set an hourly rate, create their `crew_members` pay row with `is_office=true`. No credentials handled: the operator already has a login. Money parsed to integer cents server-side. Folded in row 357 (the office clock now returns a machine-readable `reason`, so `ClockCard` says "account inactive" distinctly from "not linked").
- **#912** — Telegram for ALL staff, correcting a rule that was never Naldo's. The code refused to link Telegram for office staff; his ruling is that every staff member gets one. **The runtime always supported it** (`getCrewMemberByTelegramUserId` never filtered on `is_office`); only the admin doors blocked it.
- **#913** — one Staff panel. Deleted BOTH `/api/admin/crew-accounts` and `/api/admin/office-staff` and their components, replaced by one `/api/admin/staff` (GET/POST/PATCH/DELETE) and one `StaffAccounts.tsx`, grouped Office / Field with identical actions per row. New capabilities that existed nowhere before: **password reset** (a crew login could previously be created and never recovered), **in-app field-crew creation** (`insertCrewMember` had ZERO callers, so every crew row was hand-seeded SQL), move office<->field, and FK-guarded removal.
- **#910** — ledger rows 358 and 359.

**OPEN: #1017** (row 355, CI docs-only skip). Needs **Jason's explicit go**, not the 48h async standard, because it changes what "gates green" means for a docs-only PR and the wrap's unattended auto-merge depends on that.

**THE FINDING WORTH KEEPING.** `is_office` controls exactly ONE thing: whether `listActiveFieldCrew` offers someone when assigning crew to a job. It is the flag's only functional reader in the app. Neither clock filters on it, and it says nothing about what login someone holds. Proven by a real row rather than by reading: **Jason is `role=admin` on an `is_office=false` pay row**, which is the maximal combination (admin access, both clocks, dispatchable). So **do not move Jason to office** — it would only cost him job assignment.

**MISTAKES**
- **I shipped false UI copy TWICE, in the same paragraph, hours apart.** First that field crew "sign in with their own crew login" (Jason disproves it). Then, in the correction itself, that "anyone here can clock in from the dashboard header" (`getOfficeClockCaller` refuses crew-role logins outright, so a crew login can only text the bot). Both caught by review lenses, neither by me. The lesson is not "check copy" — I did check, and wrote a second false claim while fixing the first. It is that a claim about WHO CAN DO WHAT must be traced to the guard that decides it, every time, not reasoned from the surrounding design.
- **My own repair action could strand someone.** "Move to office", built for mis-set-type recovery, only flipped the flag: a crew-login person moved to office loses the job-assignment roster and still cannot use the dashboard clock. Worse off, nothing gained, reachable through the UI's own advertised fix. Now refused with a 409 naming the real remedy.
- **I reported row 356 as open work when it had already shipped.** I only found out because I went to build it and checked the code first. A stale ledger read presented to Naldo as a to-do list.
- **Two untested failure paths after an irreversible write**, both found by the technical lens: DELETE returned 500 if the login lookup threw AFTER the row was deleted (telling the admin nothing happened when the row was gone for good), and the field-crew POST rolled back an orphan login only on a lost compare-and-swap, not on a thrown error.
- **A read-only review agent ran `git checkout FETCH_HEAD -- .` in the shared worktree.** It was a no-op and I verified the tree immediately (branch, HEAD, deletions all intact), but AGENTS.md says reviewers read via `git show`. Worth tightening the lens briefs.

**DID RIGHT**
- **Checked before building, twice, and both times the work was already done.** Row 356's guard was already in `assignCrewToJob` on master; half of row 355 (the `concurrency` block) was already in `ci.yml`. Two builds avoided by reading the live system instead of trusting the row.
- **Re-derived every HIGH before accepting it, and refuted one.** The technical lens called a JSON-primitive body a live 500; `'x' in 42` genuinely throws, but the `crewMemberId` check returns 400 first, so it was unreachable. The negative control settled it: reverting my fix left the new test green. Kept the guard as defence in depth and **renamed the test so it does not claim to have caught a crash it never caught.**
- **Negative-controlled four guards** (the office-only write filter, the crew exclusion in the operator picker, the Telegram collision mapping, the password-reset target, the crew-login-only deletion, the move guard). Each mutation failed exactly its own test and nothing else.
- **Measured prod before designing destructive behaviour.** Queried the actual foreign keys before building Remove: six FKs across four tables, all NO ACTION, so Postgres itself refuses to delete anyone with recorded time. The guard is the database, not a check I could forget. Also queried Jason's real account rather than guessing at his access.
- **Caught the stale-CI trap.** A watcher reported green instantly; it was reporting the PREVIOUS head while the real run was still in progress. Verified the run's `headSha` against the pushed SHA and merged only after green on the exact commit, pinned with `--match-head-commit`.
- **Recorded every ledger collision instead of silently taking a number** (358/359 minted above Jason's unmerged #902 claims; 363 taken after his session explicitly reserved it for #913).

**GATES at close:** tsc 0 errors · lint 0 errors (19 pre-existing warnings) · vitest **8167 passed**. Master `caaa2c12`.

**REVIEW:** every merged PR took a FULL four-lens pre-merge round (#913's found 2 HIGHs, both mine, both fixed before the merge-go). Close pass: one integration lens over the session's combined work plus one process lens on the open #1017.

**NEXT:** Jason's explicit go on **#1017**. Row 359 (a deleted operator still orphans a pay row) is open and now visible in the panel but not recoverable. Row 358 is **MOOT** — the Operations Hub was scrapped 2026-08-27.
