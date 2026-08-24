### Naldo S66: office staff onboarded + the office web clock shipped — three PRs merged live, and TWO session-number collisions caught at wrap (2026-08-23)

> This conversation linked the three real office logins to their pay rows, shipped
> an office web time clock into the dashboard header, taught the roster the
> office/field distinction, and answered Naldo's GitHub-Actions cost question.
> Three PRs (#864, #873, #893) merged to `master` and are live. The office-onboarding
> UI Naldo asked to build is scoped and handed to the next session (not deferred —
> it's the next build). **This session is S66, not S64/S65:** the compaction summary
> said S64, but S64 is a concurrent session's open close PR #876 (eight draft PRs) and
> S65 is a *different* concurrent session's MERGED close #904 (the light-size slider,
> PR #883). Both were caught at wrap before any artifact was stamped; this session
> yielded to the next free number, S66.

## What shipped (all merged + live)

- **PR #864 — Telegram sender id + name logging for crew linking.** The webhook now
  records `msg.from.id` and name so an office admin can match a texting crew member
  to their `crew_members` row. Small, additive, premerge-reviewed.
- **PR #873 — office web clock.** `getOfficeClockCaller()` (`src/lib/auth/officeClock.ts`)
  resolves an OFFICE staffer from their OPERATOR session (never the body, never a crew
  login), fails closed (writes payroll, so it does not lean on the dormant perimeter),
  and maps five denial reasons to 401/403/503. `POST /api/office/clock` runs the
  `source:'office'` lane with double-tap AND lost-CAS-race idempotency on clock-out /
  break-end. `ClockCard.tsx` is a compact header widget that always shows a state
  (signed-out / not-linked / unavailable / live) rather than vanishing on error.
- **PR #893 — office/field flag.** New `crew_members.is_office boolean not null default
  false` (migration + `FULL-SCHEMA.sql`, same PR). New `listActiveFieldCrew()`
  (`is_office=false`) feeds the schedule/assign dropdowns; `listActiveCrewMembers()`
  (full payroll roster) is left UNfiltered so pay math is untouched. Crew-accounts
  GET filters office out; POST/PATCH 409 an office row (sibling-guard parity).
  `CrewLogins.tsx` now says office staff sign in as operators, not here.

## Prod data (verified by query, not tool success)

- Linked Kelly, Khaye, and **Ann (= ariane@, the "Ann" crew row)** operator logins to
  their `crew_members` pay rows via `auth_user_id`, and set `is_office=true` on the
  four office people (Naldo, Kelly, Ann, Khaye). Office staff removed from the Crew
  logins panel. All confirmed with `select`, not the MCP success message.

## Architecture ruling (recorded in project_p4p_labor.md A2)

Office clock CAN live in both tools at once. The Quote Tool is the system of record for
time; the office web clock here is a capture surface writing the canonical `shifts`
ledger (`source:'office'`). A Hub-side office clock can still be built later reading the
same canonical time — the crew Hub web clock (time-clock phase 3) plan is unchanged.
Office staff (operators) never enter the P4P pools.

## Session review (wrap integration lens, Sonnet 5, diff-scoped to #873+#893)

Scaled to ONE integration lens: every shipped PR already had a full 4-lens premerge
round, no live non-repo surface changed, and while the diff touches the SHARED
`crew_members` table + auth lib, nothing customer-facing is in the delta (dashboard /
office-only), so the per-PR customer lens already covered the only customer angle and a
"real page drive" would have nothing customer-facing to drive. **Verdict: CONCERNS —
1 MED, 1 LOW, no HIGH.** Both on already-merged work → deferred to ledger rows, flagged
to Naldo (neither blocks; MED sits on the same `job_assignments` table the P4P
labor-revenue work is extending):

- **MED → row 356.** `POST /api/ops/schedule` (`assignCrewToJob`) enforces the
  office/field boundary only by filtering the dropdown roster, NOT at the write — a
  direct POST with an office `crewMemberId` still inserts into `job_assignments`. No
  route test exists. Narrow blast radius today (UI-bypass only, operator-only, nothing
  reads `job_assignments` for pay yet). This is the SAME enumerate-all-consumers class
  as the #893 premerge HIGH, recurring one layer deeper — I filtered the roster reader,
  the write path went unchecked.
- **LOW → row 357.** `ClockCard` collapses `is_crew`/`unlinked`/`inactive` 403s into one
  "login not linked" message. Both surfacing paths are unreachable today (`is_crew`
  blocked by `proxy.ts` since S12; `inactive` has no in-app trigger). Pairs naturally
  with the office-onboarding UI (row 354), which is where an active-toggle would land.

## Mistakes (mine, this session)

- **Nearly wrapped under the wrong session number — TWICE over.** The compaction summary
  asserted "S64"; a concurrent session already held S64 (open close PR #876, a
  materialized `S64-naldo.md` fragment, eight draft PRs), and on the re-sync a THIRD
  concurrent session's MERGED close (#904, the light-size slider) turned out to hold S65
  too. Caught both by reading `gh pr list` + the fragments on `origin/naldo/s64` and the
  merged master before stamping anything, and yielded to S66. A session number inherited
  from a compaction summary is a hypothesis, not a fact — re-verify it at wrap AND on
  every master re-sync, because a merged claim can land after you start.
- **The office/field boundary was enforced at one consumer, not all.** The #893 premerge
  round found one (the schedule dropdown showing office as field crew) and I fixed it;
  the wrap lens then found the SAME class at the write path (`assignCrewToJob`). Two
  instances of the promoted enumerate-all-consumers pitfall in one feature.
- **describe-intent-as-fact** in #893 comments ("row 337"; `getOfficeClockCaller`
  named before it existed in-tree) — caught and softened in premerge. Promoted pitfall,
  recurrence.

## Did right

- Diagnosed the repo-wide GitHub Actions failure as free-plan minutes/capacity
  exhaustion (runs 846-850 passed in minutes; 851+ died in ~5s, runner_id 0) and handed
  Naldo the exact billing fix — after first, wrongly, reading it as a transient blip.
  Lesson kept: judge CI recovery by completion DURATION, not transient queued/in_progress.
- Fixed the #893 dropdown HIGH by scoping a NEW `listActiveFieldCrew()` and leaving the
  payroll roster untouched (test pins both), rather than filtering the shared function
  and silently changing pay.
- Negative-controlled every new guard (office 409s, race idempotency): reverted the
  guarded line, watched the RIGHT test fail alone, restored.
- Every prod write verified by query.

## Next

**Build the office-onboarding UI (row 354) — Naldo's explicit next-session ask, NOT
deferred.** A Settings → Accounts flow: pick/create an operator login → link it to a
`crew_members` pay row (create if needed) → set `is_office=true`, replacing today's
manual SQL. New API route + settings component + tests + its own /premerge + Naldo's
merge-go. Then: CI cost reduction (row 355, SHARED `.github/workflows`, Jason async
heads-up), the wrap MED (row 356), the wrap LOW (row 357).
