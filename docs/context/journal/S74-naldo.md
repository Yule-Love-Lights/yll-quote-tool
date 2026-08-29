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


---

## POST-CLOSE DELTA (same conversation, 2026-08-28 evening → 2026-08-29)

The conversation continued past the close; per the one-conversation-one-session
rule this is a delta on S74, not a new session. (The close itself had been run
by a resumed instance of this same conversation after a midday harness restart;
the post-restart half picked up here.)

**Shipped, merged + prod-verified:**

- **PR #1054 — Archive button on the geocode fix-list, guarded.** Naldo's ask:
  most of the 25 rows are import garbage. Archive (never delete; quotes and jobs
  reference properties by id), confirm dialog naming the undo path, and a
  refusal for any property with a job OR a live-pipeline quote
  (sent/viewed/approved/booked) — measured on the real list: 6 booked, 3
  viewed, 2 sent quotes sat on those exact properties, so the admin lens HIGH
  (quote converts to a job at deposit time and strands invisibly) was live, not
  theoretical. Technical lens MED fixed too: ownership check runs INSIDE the
  guard so a mismatched customer/property pair stays an opaque 404 instead of
  leaking a has-jobs boolean. Both refusal branches mutation-probed.
- **PR #1062 — manual shift entry and correction, admins only.** Naldo's
  ruling: office reconstructs a forgotten clock-in by reading the GPS timeline
  BESIDE the form and TYPING the times; GPS never writes payroll, structurally
  unchanged. Four lenses + an adversarial delta-verify, two fix rounds:
  - Staff HIGHs: an open shift is corrected WITHOUT force-closing it (the
    close would have flipped the crew member's bot to "not clocked in"
    mid-workday); every manual touch writes a dashboard_activity row with
    before/after AND a Telegram note to the crew member when linked.
  - Delta-verify HIGH (the catch of the day): round 1 guarded the clock-OUT
    against clipping a running break; moving the clock-IN clips the same break
    from the other end. Replaced with ONE containment rule — the typed interval
    must contain every break and job segment the shift has — numeric compares,
    fail-closed, negative-controlled in both directions.
  - Admin MEDs: the create path refuses non-field-crew at the WRITE (the
    promoted gate-at-the-state-change pitfall, caught recurring); the stamp is
    name (email).
  - Staff MEDs: all times pinned to Eastern regardless of device timezone (new
    src/lib/etClock.ts, DST-tested on both 2026 transition days); sanity
    confirm on >12h or <15min shifts.
- **The shifts_no_overlap DB exclusion constraint, LIVE on prod** under
  Naldo's explicit "Yes constraint" (ask-first migration category; measured
  zero overlapping pairs before apply). The database itself now refuses
  overlapping shifts per person; 23P01 maps to the app's own overlap refusal.
  btree_gist enabled. FULL-SCHEMA carries both this and shifts.manual_by.
- **docs/reference/crew-gps-notice-draft.md** — the written crew notice the
  runbook requires before any hours conversation references GPS, for Naldo to
  edit and send; mentions manual entries and the take-home van plainly.

**Data rulings executed:** Naldo moved his own staff row office→field (fleet
clock + schedulable, his click after the classifier blocked the direct write),
and DELIBERATELY moved Jason Balroop field→office ("Jason works in the
office"). ⚠️ SUPERSESSION: the S70 key fact "do not move Jason to office" is
overruled by this ruling — do not "fix" it back. Consequences on record: Jason
is not schedulable to field jobs, not on the fleet crew clock, and the manual
shift form refuses him; his dashboard clock works by login and is unaffected.

**Review at this delta's close:** one integration lens over the post-close
span including the concurrent #1063 merge. Verdict CONCERNS: 1 MED, 1 LOW, 0
HIGH. The MED was a real cross-PR find nobody's per-PR round could see: a
FUTURE-dated manual shift (an admin date typo) would silently block that crew
member's every organic clock-in (clockIn inserts now-to-infinity, collides
with the future row on the new constraint, dies as a generic error). The fix shipped
same close as PR #1069 (manual entries reconstruct the past, so a future
clock-out or keep-open clock-in refuses plainly; negative-controlled) and
waits for Naldo's merge-go. The LOW (a backdated
clock-in can mislabel a forgotten_clock_out exception's hint text) is accepted
as cosmetic. #1063 itself checked clean against this session's diffs: it
writes no shifts rows, the classifier never branches on manual_by, and
FULL-SCHEMA holds both sessions' changes without contradiction. Rows minted: 458 (no void for a bogus manual shift), 459 (paid-day
guard trigger). Gates at close: tsc 0 · lint 0 errors · vitest full suite
green on the merged tree.
