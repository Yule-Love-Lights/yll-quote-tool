# Time tracking — build plan (Jason S58, 2026-09-01)

**Status: PLAN ONLY. Nothing built. Written to be executed next session.**

Jason's ask: a Time tracking page where an **admin sees every employee's hours**, and an
**ordinary staff member sees only their own**. This document is the recon behind it and the
plan that recon produced. Read it before writing any code, and re-verify anything here that
looks load-bearing — every number below was measured on 2026-09-01 and prod moves.

---

## 0. The two things that reframe this build

**1. The hard part is already written, and nothing calls it.** `paidSecondsForShift`,
`breakSecondsForShift`, `jobSecondsForShift`, `jobSecondsByJob` and `travelSecondsForShift`
all exist as pure functions with **2,849 lines of tests** across `timeSpans.ts`,
`shiftBreaks.ts`, `jobSegments.ts` and `shifts.ts`. **Zero callers exist outside those tests** —
no page, route or component in `src/` calls any of them. This is a UI and aggregation job on
top of a tested, unused engine, not a from-scratch build.

**2. The placeholder page's stated blocker does not apply.** `src/app/admin/time-tracking/page.tsx`
says hours views wait until "the seed-rates session lands real labor rates (laborPlan.ts blocks
payout display on placeholders by design)". `laborPlan.ts` gates exactly two columns —
`jobs.budgeted_hours` and `jobs.labor_revenue_cents`, the per-job *budget* estimates. It never
touches `shifts`, `shift_breaks` or `job_segments`. **"How many hours did Ann work" was never
blocked**; only "this job's labour cost against budget" was. A feature has been sitting behind a
guard that was never in front of it.

---

## 1. What exists today (measured, not assumed)

### The clock ledger is live and in daily use

Measured against prod 2026-09-01:

| | |
|---|---|
| `shifts` | **25 rows**, 2026-08-21 → 2026-09-01 (today) |
| open right now | **2** — Naldo 1.6h, Jason Balroop 1.2h, both `source: 'office'` |
| `shift_breaks` | 1 |
| `job_segments` | **0 — never written, ever** |
| `crew_members` | 8, all active: 4 `is_office=true`, 4 `is_office=false` |
| logins linked (`auth_user_id`) | **5 of 8** |
| placeholder pay rates (`base_rate_cents = 0`) | **0** — every rate is real, $9.00–$25.00/hr |

Hours already logged: Naldo 65.77h (11 shifts), Khaye 31.69h (6), Ann 17.42h (4),
Jason Balroop 15.33h (2), Little James 5.50h (1), SonSon 5.50h (1). Big James and Kelly have
none yet.

### Three writers, already live

1. **Office web clock** — `ClockCard` in the dashboard header → `POST /api/office/clock`,
   identity resolved server-side by `getOfficeClockCaller()` (`src/lib/auth/officeClock.ts:71-112`)
   via `crew_members.auth_user_id`. Writes `source: 'office'`.
2. **Telegram crew bot** — `crewTimeHandler.ts` → `clockIn`/`clockOut`/`startBreak`/`endBreak`/
   `arriveAtJob`/`departFromJob`, `source: 'telegram'`. **The only door field crew have.**
3. **Admin manual entry / edit / void** — `POST /api/admin/shifts/manual` →
   `adminCreateShift` / `adminUpdateShiftTimes` / `adminVoidShift` (`shifts.ts:385-707`),
   surfaced today on `/admin/fleet/clocks` via `ManualShiftEditor.tsx`. Stamps `manual_by`.

**The "edit a forgotten clock-out" capability Jason asked for already exists** — it is just on the
wrong page, and shows no durations.

### What displays time data today

- `/admin/time-tracking` — admin-only placeholder. Shows only the time-exception queue.
- `/admin/fleet/clocks` — admin-only. **One calendar day at a time**, raw in/out timestamps
  beside the GPS timeline, plus the manual add/edit/void controls. **Computes no durations at
  all** — no total, no per-person rollup, no multi-day range.
- `/crew` ("My Day", #1094) — the one crew-facing page, and it is **deliberately money- and
  hours-free** by explicit design constraint, so that no later edit can leak payroll onto a
  phone screen the whole crew can open.

**No hours summary exists anywhere, for anyone.**

### Data integrity guards already in place

`shifts_one_open_per_person` (partial unique index) and `shifts_no_overlap` (a `btree_gist`
exclusion constraint) — one person can never hold two overlapping shifts, enforced by the
database. Durations are pure epoch-millisecond arithmetic (`timeSpans.ts:32-49`), so DST and
midnight-crossing shifts are correct **for duration** by construction.

---

## 2. What is genuinely missing

1. **Aggregation.** Nothing sums a person's hours over a day, week, month or arbitrary range.
2. **An approval / paid state on `shifts`.** `job_segments` has `approved_by`/`approved_at`;
   `shifts` has neither. This is the core of Jason's ask and it does not exist.
3. **A staff-type concept beyond a boolean** (see §4.1).
4. **The "admin sees all / staff sees own" page shape.** Every role-gated page in the app is a
   binary redirect: admin passes, everyone else is bounced. **Nothing does a reduced own-view.**
   This would be the first of its kind, so it must be designed, not copied.
5. **A self-service hours view** for anyone.

---

## 3. The most important design decision: approval is a SETTLEMENT, not a flag

Jason's workflow: *"we pay them via another website/cash/bank transfer, and THEN we mark the
hours as approved."*

**This exact problem was solved in this repo last week, for a different pay model.**
`src/lib/advertising/payouts.ts` (ledger row 481, merged in #1130) settles advertising workers.
Its design notes are the specification:

> SETTLED and UNPAID are **DERIVED, never stored** … a stored balance drifts, a derived one cannot.
>
> A settlement says **WHICH photos it paid**, not just "week of Aug 24, $47.50", because a photo
> inside an already-paid week can be accepted days later and period-only settlement cannot then
> tell an underpayment from a late acceptance.

Every one of those lessons transfers directly:

- **Do NOT put an `approved` boolean on `shifts`.** Create a settlement that names **which
  shifts** it paid, one line per shift, with the rate stamped on the line.
- **Derive** `approved hours` and `unapproved hours` from settlement lines. Never store a running
  balance.
- The failure it prevents is real and will happen here: approve a week, then fix a forgotten
  clock-out inside that week. A period-based approval cannot distinguish that correction from an
  underpayment. A line-based one can.
- Advertising already refuses to void a **paid** placement. Shifts need the same guard: **an
  admin must not silently edit a shift that has already been paid.** Ledger row **459** is
  already open for exactly this and is explicitly parked waiting for a paid marker to exist —
  **this build unblocks row 459**, and should close it.
- `SETTLEMENT_METHODS = ['cash','venmo','check','other']` already exists. Reuse the vocabulary.

**Recommendation:** mirror `payouts.ts` structurally — `shift_settlements` +
`shift_settlement_lines` — rather than inventing a second, different money-approval mechanism in
the same codebase. Two mechanisms for one concept is how the repo's sibling-parity pitfalls start.

---

## 4. Open questions — these need Jason before building

### 4.1 Staff type: the schema has a boolean, the design needs three values

Jason wants the admin table grouped **Office / Crew / Warehouse**. Today `crew_members` has only
`is_office` (boolean). "Warehouse" appears nowhere as a staff category — only as an inventory
location.

`is_office` is not cosmetic: it gates `listActiveFieldCrew()`, the office clock door, and who the
Telegram bot serves. Repurposing it is a cross-cutting change with real consumers.

**Recommendation:** add an additive `staff_type` column (`'office' | 'crew' | 'warehouse'`) used
for **grouping and display only**, and leave `is_office` alone as the permission/behaviour flag,
at least initially. Two overlapping fields is a smell and should be recorded as debt — but
changing `is_office` in the same PR that builds a new page risks the door that lets office staff
clock in at all. **Jason decides; do not infer.**

### 4.2 Naldo's row contradicts the grouping

**Naldo is `is_office = false`** — i.e. field crew by the flag — yet he has a web login, 11 shifts
all clocked `source: 'office'`, and `pay_mode: 'hourly'` like office staff. Jason's sketch lists 4
office and 3 crew; Naldo is the 8th person and appears in neither.

So either his row is mis-flagged and should be `is_office = true`, or the grouping is not
`is_office`. **This is a data question only Jason/Naldo can answer**, and it must be answered
before the grouping is coded, or the first screenshot will look wrong.

Related, and worth knowing: the recon's safety argument that "no field row can ever have a login"
is **already false in prod** — Naldo's row is the counter-example. Any code assuming
*has login ⇒ office staff* is wrong today.

### 4.3 "Automatic Hours" in the sketch

Jason's wireframe has a second section headed **Automatic Hours** listing Big James, Little James
and SonSon — the three field crew with no login. Intent unknown. If it means hours derived from
GPS/job segments rather than self-reported punches, note that **`job_segments` has zero rows and
has never been written**, so nothing can populate it today. **Needs clarification before design.**

### 4.4 Hours only, or money?

Rates are populated and sit on the same row. "Show hours" and "show what those hours are worth"
are one step apart in code and very far apart in consequence: the second makes every bug a
payroll error and puts one person's earnings on a screen. `/crew` was deliberately built
money-free for precisely this reason. **Recommend phase 1 shows HOURS ONLY**, with money a
separate, later decision.

### 4.5 Field crew cannot use the staff view — confirm this is accepted

**Field crew have no web login, permanently and by design** (crew logins retired 2026-08-28, row
438). Little James, SonSon and Big James clock in via Telegram and cannot open a web page.
The self-service half can therefore only ever serve **office staff**. Their hours will still
appear in the admin view. If they must see their own hours, that is a Telegram feature, and a
separate build.

### 4.6 Approval granularity

Per shift, per day, or per arbitrary selection? The settlement model supports any of them
(a settlement names its lines), but the **UI** needs a decision. Recommend: admin selects a date
range for one person, sees the unapproved shifts, and approves that set as one settlement.

### 4.7 Overtime is parked

Ledger row **285** parks the overtime regular-rate formula pending a payroll/accountant review.
No overtime logic exists. Confirm phase 1 ignores overtime.

---

## 5. Proposed build order

Each phase is independently shippable and independently useful. Do not start a later phase
before the earlier one is merged and checked in a browser.

**Phase 0 — decisions.** §4.1–4.7 answered. No code.

**Phase 1 — the admin read-only view.** `/admin/time-tracking` gains the summary table:
per-person totals grouped by staff type, columns name / total hours / hours today (if clocked in).
**No approval columns yet, no money.** First real callers of `paidSecondsForShift`. Pure
aggregation on top of tested math — the cheapest, safest slice, and it immediately answers "how
many hours has anyone worked", which nothing does today.

**Phase 2 — the per-person detail page.** Hours by day / week / month for one person, with the
existing manual edit/void controls moved or mirrored from `/admin/fleet/clocks`. Row **473**
(manual payroll edits are recorded where nobody looks) should be closed here by surfacing the
audit trail on this page.

**Phase 3 — the settlement (approval) mechanism.** Migration + `shiftSettlements.ts` mirroring
`payouts.ts`. Derived approved/unapproved. The paid-shift edit guard, closing row **459**.
**This is the money phase — it takes the full four-lens review and an adversarial delta-verify.**

**Phase 4 — the staff self-view.** Same detail page, own data only, edit and approve controls
absent (not merely hidden), clock in/out buttons. Office staff only.

**Phase 5 (optional) — warehouse grouping and anything money-facing**, if §4.1/4.4 said yes.

---

## 6. Traps specific to this build

- **Day/week/month bucketing is where the timezone bugs live.** Duration math is
  millisecond-based and immune, but "hours on Tuesday" and "this week" are calendar questions and
  must use the **America/New_York business day**, not UTC. This repo has already shipped this bug
  twice: `ScheduleDay` defaulting to the UTC calendar day (row 335, opens on *tomorrow* after
  ~8pm ET), and a prod "today" query landing on the wrong day in S53. Pin the business-local
  clock first.
- **Open shifts must be handled explicitly.** Two are open right now. Decide and state whether an
  open shift counts toward "hours today" as time-so-far, and never let an open shift silently
  contribute a null or a negative.
- **The perimeter will not protect this page.** `src/proxy.ts` default-allows any authenticated
  operator to any path; only the page's own `getSessionRole()` check stands between an ordinary
  operator and everyone's pay data. The self-view must resolve identity server-side via
  `auth_user_id` (mirroring `getOfficeClockCaller`) and must **never** accept a crew-member id
  from the client.
- **An unlinked operator must fail closed.** `auth_user_id` is null until an admin links the
  login. An operator with no linked row must see an explicit "not linked" state — **never** a
  fall-through that shows all data.
- **`linkStaffLogin` is not office-restricted at the database level** (`crewMembers.ts:664-685`);
  only route convention keeps it office-only, and `getOfficeClockCaller` does not check
  `is_office` either. Do not assume the schema enforces the office/field boundary.
- **Editing a paid shift** must be refused at the state change, not merely hidden in the UI.
- **The page must be driven in a real browser before it is called done** — AGENTS.md Pitfalls,
  Jason's ruling 2026-08-29 (closed row 259): the suite tests maths and data, never screens.

---

## 7. Ownership

`AGENTS.md` currently assigns the P4P labor surface — `crew_members`, `shifts.ts`,
`shiftBreaks.ts`, `jobSegments.ts` — to **Naldo** (added 2026-08-27, row 433).

**Jason states 2026-09-01 that Naldo has handed this surface to him fully**, moving it from
Naldo's task list to his, and that no further notice or approval is needed.

Recording it here rather than editing the ownership table unilaterally: an ownership change is a
policy change, and AGENTS.md's own rule says those need both devs. **The ownership table should be
updated in the first build PR, with Naldo's acknowledgement noted.** Until then this document is
the record of the handoff.

**Done 2026-09-02 (S59):** Naldo gave his written one-line ack to Jason's direct message; the
AGENTS.md ownership table now carries the surface under Jason, in its own docs PR rather than the
build PR (#1176), so the policy change is reviewable on its own.

---

# Part 2 — automatic hours, navigation, and P4P (Jason, 2026-09-01)

Added after the plan above was written. Jason explained the "Automatic Hours" section of his
sketch, which §4.3 above had flagged as unknown. **Where this contradicts Part 1, this section
wins.**

## 8. Corrections to Part 1

- **§4.5 is WRONG.** Field crew are NOT permanently excluded from self-service. Little James,
  SonSon and Big James **will** clock in and out through **Telegram** — that path exists
  (`crewTimeHandler.ts`) and simply is not set up for them yet (only 1 of 8 staff has
  `telegram_user_id`). They will never use a web login; Telegram is their door. So "every staff
  member can see and track their own hours" IS the goal — the surface differs by population.
- **The Fleet tab is now called Schedule.**

## 9. What automatic hours actually is

A **safety net and a measurement**, not the primary clock. Three distinct purposes:

1. **Backup for a forgotten punch.** The van leaves Naldo's house (the depot) → the crew's hours
   start. The van returns to the depot → they stop. If someone forgets to clock in or out, this
   is the fallback record.
2. **Time spent at each customer's house.** Surfaced on that **job's own page** ("time spent on
   this job") when the job is marked installed, for accurate record-keeping.
3. **Feeds future insights** — cost per job as labour + materials, for bookkeeping and expenses.

### This is far more built than expected

Measured in prod 2026-09-01:

| | |
|---|---|
| vehicles tracked | 1 |
| `vehicle_events` (raw GPS) | **2,524** |
| `vehicle_visits` kind=`depot` | **8**, avg 6h27m, 1 open now |
| `vehicle_visits` kind=`job` | **3**, **all 3 carry a `job_id`**, avg **1h48m** on site |
| `vehicle_visits` flagged `below_min_dwell` | 1 of the 3 job visits |
| **`vehicle_crew`** | **0 rows** |

**Depot-vs-job detection already works and job visits are already linked to the right job.**
Purpose 2 above is therefore mostly a display job on data that already exists.

**The single blocker is `vehicle_crew` — the table saying who was in the van is empty.** Without
it, GPS time has no owner. This is the S67 lesson again: the schema's shape is not the capability.

Note also: `adminCreateShift` **already reconstructs a forgotten punch by reading the GPS
timeline** — a human-assisted version of purpose 1 partly exists on `/admin/fleet/clocks`.

### Jason's rulings on the mechanism (2026-09-01)

- **Automatic hours are a SUGGESTION an admin accepts, never an automatic write.** The
  GPS-derived day shows beside the clocked day; if the crew forgot to punch, an admin accepts it
  and it becomes a real shift stamped as manually created. **Nothing becomes payable without a
  human deciding.** This also avoids colliding with `shifts_one_open_per_person` and
  `shifts_no_overlap`, which a silent auto-writer would trip the moment someone also clocked in
  by hand.
- **Van crew is assigned PER DAY, not standing.** The existing `vehicle_crew` table
  (`vehicle_id, crew_member_id, active`) has **no date column**, so this needs a schema change.
  Where the daily assignment is made (probably from the Schedule page, which already assigns crew
  to jobs via `job_assignments`) is still open.

## 10. Navigation — this is NOT a top-level tab

Jason's placement, which supersedes any assumption that the page lives at a top-level nav item:

- Top-level nav stays: Home, Inbox, Tasks, Quotes, Jobs, Schedule, Invoices, Inventory, New quote.
- **Time tracking lives in the account dropdown** (the initials menu, e.g. "JB"), beside
  Settings, Insights, Call recordings, Website leads. That menu is new — Naldo built it in
  #1134 and added entries in #1144.
- **The page itself has sub-tabs**, the same pattern Settings uses (Settings / Training /
  Customer portal / Accounts):
  - **Hours** — everything in Part 1. This is the focus.
  - **P4P** — a separate tab, **explicitly not now**.

The existing route is `/admin/time-tracking`. Reconcile the route with the account-menu placement
before building; do not assume the current path is final.

## 11. P4P — captured for context, NOT in scope

Performance-based pay: crew earn extra when they finish a job faster than expected **and** the
customer has no complaints. Its own tab, built later. Recorded here only so the Hours work does
not accidentally foreclose it.

Relevant existing pieces: `crew_members.pay_mode` already has a `'p4p'` value and an
`in_p4p_pool` boolean; all four field crew currently sit at `pay_mode: 'shadow'`. Ledger row
**283** (success metrics for P4P) and row **285** (the overtime regular-rate formula, parked
pending an accountant) are the open questions in this area. **Do not build against any of it yet.**

## 12. Still open after Part 2

- Does depot-to-depot time include **driving and lunch** as payable? The manual clock has a break
  button; GPS knows nothing about breaks.
- A job with **two visits in one day** (a real double-back is recorded in S74) — one line per
  visit on the job page, or one total?
- Do **`below_min_dwell`** visits count, or show greyed? One of the three real job visits is
  already flagged.
- Where is the **per-day van crew assignment** made, and by whom?

---

## 13. Answers to §12 (Jason, 2026-09-01)

**(a) Depot-to-depot time is ALL payable**, driving and lunch included.

> ⚠️ **Consequence to settle before phase 3, flagged rather than silently encoded.** The two
> sources will disagree systematically. The manual clock subtracts unpaid breaks —
> `paidSecondsForShift` is the clock envelope MINUS `breakSecondsForShift`, and the app has a
> break button crew are expected to use. GPS knows nothing about breaks. So an accepted automatic
> day pays MORE than the identical day clocked by hand with lunch punched, and a crew member who
> forgets to clock in is paid more than one who does not.
>
> That may be exactly what Jason wants (if you forget, we pay the van's day, and the incentive is
> to punch correctly). It is recorded here because it is a money rule, it will show up as a
> discrepancy the first time both sources exist for one day, and whoever builds the accept flow
> must not "fix" it by quietly deducting a break the GPS never saw. **Confirm the intent at
> phase 3.**

**(b) The job page shows ONE LINE PER VISIT**, not a single total. Each line carries:
- the **date** (a job can span multiple days) and the **arrival time**
- the **duration** of that visit
- **which staff members were there**, and **how many hours each spent on that job**

So the count of lines is itself the answer to "how many times did we go back". Note this needs
per-person attribution at the JOB level, not just the day level: it is `vehicle_crew` (per-day,
once it has a date column) crossed with `vehicle_visits`. If two crew rode the same van, both get
that visit's duration; anyone who travelled separately will not appear until there is a source
that knows they were there.

**(c) `below_min_dwell` visits are IGNORED.** They are drive-bys, not work. One of the three real
job visits in prod today is already flagged this way, so the filter is load-bearing from day one —
without it that job would show a visit nobody made.

---

## 14. CORRECTION to §13(a) — where payable time ENDS (Jason, 2026-09-01)

**§13(a) said depot-to-depot. That is WRONG. This section supersedes it.**

Automatic payable time runs:

> **START** — the van leaves Naldo's house (the depot).
> **END** — the crew leave the **last install of the day**.

**The drive home is NOT payable.** Driving out to the first job and driving between jobs IS
payable; the return leg to the depot is not.

In terms of the data that already exists: payable time = from the **exit of the day's depot
visit** to the **`exited_at` of the last `kind='job'` visit of that day** — NOT to the
`entered_at` of the evening depot visit. The evening depot visit still matters as a day boundary
and as the signal the van is home, but it does not extend paid time.

Consequences to build to:

- `below_min_dwell` visits are ignored (§13c), so "the last job of the day" means the last
  **counted** job visit. If the final stop is a drive-by, payable time ends at the previous real
  job visit, not at the drive-by.
- A day with a depot departure but **no counted job visit** yields **no automatic payable time**.
  Do not fall back to the depot return — that is the exact rule this correction removes.
- This narrows but does not close the §13(a) discrepancy: the return drive no longer inflates the
  automatic figure, but **lunch is still payable in the automatic number and still deducted in
  the manual clock**. The §13(a) warning otherwise stands, and is still for phase 3.

**Still open, asked and not yet answered:**
- If the last stop of the day is **not a job** (a supply run, fuel, a dump run), does payable time
  end at the last JOB exit or the last STOP of any kind? As written it ends at the last job, so an
  hour collecting materials after the final install would be unpaid.
- Is a day spent entirely **at the depot** (a shop day, no jobs) outside automatic hours
  altogether? As written, yes — it produces nothing.

---

## 15. What decides "the last job", and the double-back (Jason, 2026-09-01)

### The schedule is EMPTY — measured, and it nearly took the spec with it

Jason's §14 wording was "the last job **on the schedule** for that day". Measured in prod
2026-09-01 before writing any of it down:

| | |
|---|---|
| `jobs` total | **44** |
| jobs with an `install_date` | **0** |
| `job_assignments` | 2, **none in the last 30 days** |

**Nothing has ever been scheduled.** (Consistent with the S57 note: "No install dates exist for
any of the 20 yet and that is expected — dates come first, then scheduling.") Had the schedule
been made authoritative, automatic hours would have computed **nothing at all** on every real day
— shipped dead on arrival, waiting on an operational habit nobody has started. That is the
inert-feature class AGENTS.md already names.

GPS has no such problem: all **3** real job visits already carry the correct `job_id`, derived
without the schedule.

### Jason's rulings

**(a) GPS now, schedule later.** The day's counted `kind='job'` `vehicle_visits` decide the last
job. The schedule becomes a **cross-check** once install dates are actually being set — it makes
the answer more correct, and must never be a precondition for producing an answer. Build it so
an empty schedule degrades to "GPS only", never to "no hours".

**(b) A double-back is ONE CONTINUOUS WINDOW.** Crew leave the last job at 14:00 and return
16:00–18:00 to finish: payable time runs unbroken from the depot departure to the **final**
departure at 18:00, **the 14:00–16:00 gap included**. Consistent with §13(a) (driving and lunch
are payable). Simplest to compute and to explain at payroll time.

So the complete automatic rule, superseding all earlier partial statements:

> Payable automatic time for a crew member on a date =
> from the **exit of that day's depot visit**
> to the **`exited_at` of the LAST counted `kind='job'` visit of that date**,
> as one continuous window, gaps included.
> `below_min_dwell` visits never count, including as the "last" one.
> A date with a depot departure but **no counted job visit** produces **nothing**.

### Build note

The continuous-window rule makes this cheap: it is two timestamps per crew member per date, not
a sum of intervals. The per-visit detail (§13b, the job page) is a separate computation over the
same visits — do not try to derive one from the other.
