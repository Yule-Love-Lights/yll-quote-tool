# S74 (Naldo) — 2026-08-28 — fleet page verified, repaired, rebuilt to spec, and proven on a real job day: 3 PRs merged and live

> Session number note: the handoff said S72, and every repo-side check agreed. S72 was
> in fact held by the referral session in the machine-local self-assessment, the one
> place git cannot see, and S73 was taken the same way the day before. This session is
> S74, claimed at wrap after checking master, the archive, every open PR, AND the local
> file. That local-file door has now bitten twice (S73 documented it; S74 walked into
> it), so it was promoted to the AGENTS.md session-number pitfall this close.

## What shipped

- **PR #1036, merged + prod-verified: the /admin/geocoding fix-list had been dead
  since it shipped.** The page selected `customers(display_name)`; the real column is
  `name`. PostgREST answered 400 to every request, the error path returned an empty
  list, and the page told staff "Nothing needs fixing" while 25 unschedulable
  properties existed. Found by measuring (the page said zero, prod counted 25, the
  Supabase API log showed the 400), fixed, and the failure mode itself fixed too: a
  load error now renders a visible error card, never the all-clear. Verified both
  directions against prod with the real service client before the PR existed.
- **PR #1040, merged + prod-verified: the fleet page became a real tool.** Leaflet +
  OpenStreetMap live map (no API key, no customer data in any request), field-only
  crew clock, at-place timer ("At Depot since 6:50 AM · 43 min"), day list, 2-minute
  auto-refresh, and honest tracker-asleep wording (an OBD tracker sleeps when the
  ignition is off, which is most of any real visit; the old copy read that as
  "position unknown, not parked"). Two review lenses pre-merge (technical PASS; staff
  0 HIGH / 6 MED, five fixed in the round, one accepted), then a same-day device
  round with Naldo produced three more fixes shipped in the same PR.
- **PR #1046, merged (by a concurrent chat, deliberately) + prod-verified: the
  two-clocks split.** The payroll-versus-GPS comparison moved to /admin/fleet/clocks,
  ADMIN ONLY via the new `getSessionRole` (fail-closed; crew and advertising logins
  excluded before the role collapse — the S58 seam, now pinned by tests whose crew
  branch is mutation-probed). The fleet page is live-only for all office operators.
  Fleet became its own nav area; Jobs and Fleet no longer co-highlight (Naldo: bug,
  not an accepted cost). Full four-lens round: customer PASS, technical and admin
  converged on the untested gate (fixed same hour), staff's real finding is recorded
  as a decision: non-admin office staff now have NO GPS-history surface, so "when did
  the van arrive yesterday" requires an admin.
- **Naldo's staff row moved office → field** (his click, after my direct write was
  classifier-blocked): he appears on the fleet crew clock and is assignable to jobs.

## The real-world proof

Job #1046 (166 Van Buren St, West Babylon) was assigned for the day on the existing
schedule page as the test. The tracker then recorded the whole day unattended: depot
6:50→10:10 AM, job visit 10:24→11:10 AM (47 min), depot 11:41→12:01, second job visit
12:11→4:36 PM (the double-back captured as two visits, exactly as designed), depot
arrival 5:19 PM. Beside it the crew clock: Naldo in 7:01→10:15 and 10:15→5:26. That is
the first real duration data the scheduling design has been waiting on (rows 431/432),
and the 120 m radius behaved.

## Decisions recorded (do not re-litigate)

- Fleet page access: ALL office operators for the live view (Naldo, over the
  narrower you-and-Jason idea). The two-clocks comparison: admins only.
- The scheduling design doc gained a 2026-08-28 addendum from Naldo and Jason's call:
  manual person-to-vehicle assignment per day (answers the doc's open "crew or
  vehicle?"), the Staff section is Jason's build (all-staff hours; automatic GPS hours
  separate; P4P its own tab and own kickoff; marking off PART of a day's hours is a
  hard requirement), Copilot is dropped this month (bills the 16th), scheduling wanted
  inside ~2 weeks.
- Truck-and-trailer tracker activates later (row 454 holds the steps).

## Review at close

Wrap ran one integration lens plus the customer lens (package.json is a SHARED path,
so the customer lens ran with a live logged-out drive). Findings recorded in the wrap
block of the journal entry; dispositions in rows 454-457.

## Ending state

Master at close: see close PR. Gates at close: tsc 0 · lint 0 errors (19 warnings) ·
vitest green (8459 at the last combined-tree run; the suite grew all day as five-plus
concurrent sessions merged). Ledger: minted 454-457, counter to 458, above Jason's
open #1052 which holds 450-453.
