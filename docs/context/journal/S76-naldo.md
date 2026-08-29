# S76 (Naldo) — 2026-08-28→29 — the ops hub plan finished and live: View-as as a header menu, time tracking, the advertising lane tested with real photos, and the suggestions round built same-night

> Number claimed at close 2026-08-29 ~04:30 ET after the full sweep (fragments, close PRs, remote branches, and the machine-local self-assessment, which is the S73 lesson): S75 was the calls session, nothing held S76. If a concurrent session's close also claims S76, the merged claim wins and this fragment renumbers.

## What shipped (all merged to master, all lens-reviewed pre-merge, prod deployment verified READY per merge)

- **#1063 (`f1a7562a`), the one-merge integration** under Naldo's explicit one-merge goal: the admin View-as mechanism (#1055's view context + `navItemsForView`), the `/admin/time-tracking` page holding row 278's time-exception queue (#1059), the invoices "Unreconciled (N)" chip (#1060), the time-exceptions API tightened to admin-only (Naldo's ruling 2026-08-29), the #1061 advertising surfaces absorbed at their newest commits, the View-as Advertising wiring (view seeded from the page's own area, so a switch survives navigation with zero client persistence), and `scripts/advertising-e2e-smoke.ts`. Superseded and closed #1055/#1059/#1060/#1061.
- **#1071 (`4b721674`)**: Naldo's device-round design — View-as became a compact header dropdown in the Sign-out slot (Office current, Advertising live, Crew honestly disabled, Sign out last), the strip deleted outright, so the #1055-era pop-in class cannot exist. A localStorage role hint makes the menu present at first paint from a browser's second page onward; the session fetch stays the truth and the hint clears on sign-out (staff lens MED). Operators byte-identical.
- **#1072 (`30845675`)**: review-queue duplicate candidates split by signal strength with the weak worker-day-only list behind a toggle (photos one tap away, never invisible — the admin lens corrected my own suggestion here), per-worker door-hanger counts paged to completeness, and the worker earnings "rate changed since you placed these" note.
- **#1073 (`1794676c`)**: the morning digest carries "Stuck time records: N" with the link, only when N > 0; the queue page links the manual shift editor as the fix path (#1062 shipped it same night).
- **Prod data ops**: the capture-to-pay smoke ran against the live database with generated sample photos (a yard sign and a door hanger) — 24 invariants including accept stamping exactly 250 cents, idempotent re-accept, reject-requires-reason, door hangers unpaid under the then-current rule, is_test excluded from pay and duplicate flags, teardown byte-identical incl. audit rows. 19 orphaned audit rows from the script's first runs were deleted and verified 0 remaining.
- **Documents**: the full operations suggestions list (11 items, dispositioned same night: 1-3, 5, 7 built and merged; 4 delivered as a print-ready sign-crew hire sheet; 8 executed; 6 drafted for AGENTS.md pending Jason; 9 awaiting Naldo's crew-door ruling; 10-11 advisory).

## The night's shape (for the next reader)

Concurrent sessions moved master roughly a dozen times during this session's work: the advertising session built and merged workstream B itself mid-flight (#1061, then #1077 which REVERSED the door-hanger pay exclusion, then the still-open #1078), the calls session merged its lane, payroll/manual-shift merged, S74/S75 closed. The one-merge bundle had to re-sync onto a master that had already merged a newer copy of a branch inside the bundle. That experience is suggestion 6 (one session per lane), drafted for AGENTS.md with Jason's eyes: "One session per workstream lane. A session that finishes a lane merges that lane; concurrent sessions never bundle another session's open branch."

## Review record

Every merged PR carried its pre-merge round: CODE-tier lens pairs on #1059/#1060/#1071/#1072/#1073, a FULL four-lens on #1055's mechanism and on the #1063 combined tree, adversarial delta-verifies on both substantive fix rounds, and this wrap's integration lens over the whole shipped set. Zero HIGH findings survived to a merge; the one HIGH of the night was MINE (see the scorecard) and was fixed before its PR landed. Combined-tree gate before the final three-PR landing: 9156 tests across 522 files, tsc 0, lint 0 errors.

## Open threads

- Crew view stays disabled in the menu until Naldo rules on its door (crew logins retired in #1045; a Telegram-linked link fits how crews already work) — row 466.
- The one-session-per-lane AGENTS.md draft needs Jason's eyes — row 467.
- Post-#1077 drift, sharpened by this close's integration lens (HIGH on this session's own artifact): #1077 removed the kind filter from `summarizeEarnings`, so a pending door hanger now estimates 250 cents and the smoke script's "door hanger earns/pends 0" checks WILL FAIL its next run; the pay page's "(unpaid)" label and two never-pay comments are stale too. Row 468, flagged to Naldo directly at close; the label half is also flagged on the open #1078.
- The settings page carries a pre-existing ~433px horizontal overflow at 375px width (control-measured: identical for operator/admin, menu closed/open, untouched by this session) — row 469.
