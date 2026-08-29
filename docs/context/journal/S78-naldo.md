# S78 (Naldo), 2026-08-29: the silent-empty class closed on three surfaces, a payroll row made deletable, and a wrap review that found the hole in my own delete

> Session number note: the handoff said S75. By the time the first PR was ready master
> had moved 51 commits, S75 and S76 fragments had landed, and PR #1087 held S77; the
> machine-local self-assessment confirmed all three. This is S78, re-checked at wrap.
> That is the second session running where the number had to be corrected mid-flight,
> and the cause is the same both times: a long-lived handoff written before other
> sessions closed.

## What shipped

- **PR #1069, merged and live: a manual shift can no longer be dated in the future.**
  Carried over from the S74 post-close round, brought current with master twice as it
  moved underneath, gates re-run each time, merged pinned to the verified SHA.
- **PR #1091, merged, live, and device-checked by Naldo: three silent-empty reads and
  the void action.**
  - **Row 455.** `listActiveFieldCrew` returned an empty array for three different
    situations: no service client, a failed query, and a company with genuinely no
    field crew. Both callers rendered that as an ordinary empty dropdown, so a broken
    query looked exactly like nobody being available, on the page that gates all
    scheduling. It returns null when the roster could not be READ, and the schedule
    page and the admin clocks page both say so.
  - **Row 457d.** `listFleetDays` swallowed both source query errors into an empty
    list, so a failed read looked like a quiet stretch with no data. Returns null on
    either failure. The office filter still fails open on purpose: over-listing days
    is the safe direction for navigation.
  - **Row 457b and 457c.** A stale `/admin/fleet?date=` bookmark silently showed
    today; it now says where the day view went and links there for admins. The "the
    van is not the person" caveat moved onto the all-office live page, which is the
    page actually showing at-place timers to the whole office.
  - **Row 458, the substantial one.** An admin could type a manual shift and
    afterwards only edit its times, so a bogus row lived forever, because shrinking it
    to a minute pollutes payroll rather than removing it. Voiding DELETEs the row. A
    guarded delete beat a void marker on measurement, not taste: a marker would have
    needed the shifts overlap constraint changed (an ask-first migration) and every
    reader of paid time taught about it, while a delete needs neither. Three guards,
    all fail-closed: the row must be an office-TYPED entry (`source='office'` with a
    manual stamp), it must carry no break or job segment, and the delete is a CAS on
    `updated_at`. Each was mutation-probed.
  - **Row 456.** `docs/reference/geocode-fix-list-triage.md`, measured against the
    real archive guard rather than by eye: 7 test rows archivable, 7 real customers
    the guard WOULD let you archive (fix, do not archive), 11 blocked, and 9 of the 25
    carrying no address at all.
- **PR #1095, merged: the ledger rows corrected** so 455 and 458 read as shipped and
  456 and 457 stay open for the parts that are still a person's job, not code.
- **PR #1098, OPEN at close, awaiting Naldo's go: the wrap review's own HIGH fix.**

## The wrap review, and what it found in my own merged code

Four lenses. Two of them reached the same HIGH from different directions.

`adminVoidShift` deleted the payroll row and THEN wrote the audit entry, through a
helper that logs a failure and carries on. A failed insert left a payroll row
permanently gone with no record anywhere, while the route answered ok and the confirm
dialog promised "the activity log keeps a record of what was removed". Re-deriving it
rather than taking it on report made it worse: supabase-js returns a failed insert as
`{ error }` and does not throw, so the insert's error was never read and the try/catch
only ever caught a transport fault. An RLS refusal came back as a quiet success.

Fixed in #1098: the audit writer reports its failure, and the void writes the entry
BEFORE the delete and refuses on failure. Of the two ways this can lie, an entry for a
removal that did not happen is the recoverable one, because the shift is still on the
page.

Other findings, all dispositioned:

- **Staff lens, 3 MED, all fixed in #1098.** The roster-failure notice said "the picker
  below is empty" when `AddShiftForm` returns null and renders nothing at all. The
  Remove confirm never named the shift, which is no check at all on a day holding
  several manual entries. The crew Telegram note invited a reply the bot answers with
  "Didn't understand that", to someone who just learned time was removed from their
  pay.
- **Admin lens, 1 MED, recorded as row 473.** The `shift-manual-*` entries are not
  discoverable from any payroll or fleet page; the only reader of `dashboard_activity`
  is the inbox activity feed, which has no label for them and caps at 100 rows.
- **Admin lens, clean where it counts:** it checked the triage doc's claims against
  `propertyArchiveBlock` and they match exactly, and found access control and every
  hours aggregate untouched by the delete.
- **Technical lens ruled things OUT with evidence**, which is worth as much as a
  finding: the check-then-act window between the child guard and the delete is real in
  the code but unreachable, because a voidable row can never be reopened and both
  child-creating paths refuse on a closed shift.
- **Integration lens found the cross-session break** no per-PR review could see. Open
  PR #1094 adds a new consumer of `listActiveFieldCrew` written against the OLD
  contract, catching a throw from a function that now returns null instead. It proved
  it by merging onto master and compiling: two real tsc errors. Flagged on that PR
  with the exact fix rather than edited underneath its session.

## Ending state

Master `17446edc` plus whatever lands next. Gates on master at close: tsc 0 errors,
lint 0 errors with 21 pre-existing warnings, vitest 9255 passing. One run reported a
single unhandled error outside the tests; a second full run did not reproduce it, so
it is recorded as a flake, not a break. Gates on the open #1098 branch: tsc 0, lint 0
errors, vitest 9268.

## Decisions on record

- A guarded DELETE, not a void marker, for a wrongly created manual shift. Chosen on
  blast radius: no schema change, no constraint change, no reader of paid time needs
  to learn about it.
- Row 459 stays parked. `shifts` has no paid or approved marker, which is the row's
  own precondition, re-verified against `migrations/FULL-SCHEMA.sql` today.
- The geocode fix-list cleanup is a staff task, not code. The tool already refuses to
  archive anything carrying a job or a live quote.

## Next up

- Merge #1098 once Naldo has read it.
- PR #1094's owner fixes the null contract before merging; the comment on that PR has
  the change.
- Naldo: send the crew GPS notice before any hours conversation references GPS, and
  work the fix-list from the triage doc.
