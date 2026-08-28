# Operations Hub audit and build plan (inside the Cool Tool)

> First audit-and-planning pass for folding the Operations Hub into the quote tool,
> run 2026-08-27 against master `0d45a3e9` per the prompt in
> `project_operations_hub_inside_cool_tool.md`. Six parallel read-only recon agents
> covered auth/perimeter, office surfaces, crew/time/Telegram, inventory,
> integrations, and schema; production row counts were measured directly against
> the live Supabase projects the same day. No code was written, no migrations
> created, no production data changed.
>
> **Updated the same evening** after Naldo's Call Copilot teardown (the "Call
> Copilot Teardown" artifact, audited against yll-call-copilot master fb1bf32)
> and his four follow-up rulings. The teardown changes this plan in three
> places, all applied below: Office Tasks moves across as the one task list
> (reversing this audit's first recommendation), the calls workstream widens
> from "bridge only" to merging the whole grading pipeline into the Cool Tool,
> and calls become the first build after role hardening. Data ruling: nothing
> migrates from the copilot database; the merged features start fresh in the
> Quote Tool project, and the copilot repo plus both leftover Supabase projects
> retire after the merge. One caution recorded here on purpose: retiring the
> copilot project deletes the 1,211 historical transcripts, 260 scores, and
> 1,200 learnings with it, so take a cheap one-time export snapshot before
> decommissioning, even though none of it is being migrated.

## 1. What already exists

**Office side: essentially complete.** The nav today is Home, Inbox, Customers,
Quotes, Jobs, Fleet, Invoices, Inventory, Insights, Settings (`OperatorNav.tsx`). The
Inbox is already the office work queue the plan asks for: one queue for every
unanswered customer message across GHL, Gmail, the quote form, and Homeworks,
grouped by contact, with claim/release per operator, escalation levels (amber at
1h, red at 4h), scheduled follow-ups, and handled/dismissed states. Every office
need in the plan maps to an existing mechanism: new leads and quote requests
(Inbox plus quote status filters), follow-ups (Inbox due list), claiming (Inbox
claim), overdue monitoring (escalation dots plus the dashboard NeedsAction card),
upcoming jobs (Jobs filtered to to_schedule), crew completion signals (job status
pipeline plus the fulfillment Kanban). Leads (`/admin/leads`) and Schedule
(`/admin/schedule`) exist as pages with no nav slot; Schedule is a live crew
dispatch day view backed by `/api/ops/schedule` and `job_assignments`.

**Auth: one shared Supabase store, two enforced roles plus one marker.**
`roleOf` (`src/lib/auth/supabaseServer.ts:143`) is a closed admin/operator
binary. Crew is a separate `CREW_ROLE` marker enforced at exactly three points:
`getOperator()` returns null for crew, `src/proxy.ts:48` confines crew sessions
to `isCrewPath` (`/api/ops/v1/**`), and the admin users route refuses crew
targets. Admin-only controls are narrow and real: account CRUD
(`/api/admin/users*`), the unified staff panel (`/api/admin/staff`), bot roster,
leads admin, site-forms, and a customers backfill, all behind `requireAdmin()`
which never dormancy-bypasses. Everything else under `/admin/*` is
operator-gated, not admin-gated; the URL prefix is a naming convention only.

**Crew and time: built, live through Telegram only.** The full data layer is
alive and load-bearing: `shifts.ts`, `shiftBreaks.ts` (NOT deleted by #1027,
only a comment changed), `jobSegments.ts`, `crewMembers.ts`, `scheduling.ts`,
all with DB-level idempotency (partial unique one-open-per-person indexes, race
recovery on 23505). Crew clock in/out, breaks, arrive/depart by job number with
required stoppage reasons, and job-done all work today through a deterministic
Telegram parser that never routes pay actions through the LLM. The office web
clock (`ClockCard` to `/api/office/clock`) is the only other consumer.
`crewAuth.ts` (`getCrewCaller`/`requireCrew`), the payroll-grade session
resolver the deleted v1 routes used, is complete, tested, and has zero route
consumers; a crew login today can authenticate but reach nothing (bounces to
`/login?error=crew-account`). Pay math exists as pure tested functions
(`paidSecondsForShift`, `jobSecondsForShift`, `travelSecondsForShift`) with no
consumer, and `laborPlan.ts` structurally blocks any payout display until real
labor rates replace the placeholders (needs the Naldo-and-Jason seed-rates
session). `/api/ops/time-exceptions` is fully built and has no UI.

**Inventory: a populated catalog, dormant stock flows.** The catalog holds 877
SKUs and the fulfillment Kanban is real, but the stock side has never been used.
The model is SKU-count plus job-fulfillment; nothing tracks individual units,
who holds them, or placed/recovered states.

**Calls: metadata in this repo, the heavy chain in the sibling.** The inbox
already ingests GHL call activity as bare metadata (channel 'call', direction,
timestamp, no body) via a 1-minute reconcile cron plus a payload-less webhook.
A real Whisper wrapper exists (`transcribe.ts`) but serves crew Telegram voice
notes. The sibling `yll-call-copilot` Supabase project already does the heavy
chain in production: 1,211 transcripts, 450 call recordings, 260 call scores
against a rubric, 79 feedback cards, 1,200 learnings. The bridge from those
scores into this app is already designed as epic #217 (post-call commitment
engine, `docs/superpowers/plans/2026-08-06-post-call-commitment-engine.md`,
hardened by two review rounds) and entirely unbuilt; its `call_commitments`
table exists nowhere.

**Schema and conventions.** 45 tables in `migrations/FULL-SCHEMA.sql`; the
default posture is RLS enabled with zero policies and service-role-only access. Newer money is integer cents
(`base_rate_cents`, `labor_revenue_cents`); legacy quoting money is numeric
dollars. Timestamps are timestamptz UTC with America/New_York conversion in app
code. Append-only audit tables (`dashboard_activity` shape), CAS and
partial-unique idempotency patterns, `is_test` flags, private storage buckets
with signed URLs, and a strict geocode gate (`geofenceAnchorRefusal()` wired
into `findOrCreateProperty`) are all established precedents. The fleet-GPS
cluster (`vehicles`, `vehicle_crew`, `vehicle_events`, `vehicle_visits`, built
this week) is the closest analog for GPS-plus-photo evidence, including the
privacy ruling that customer coordinates never leave this database
(poll-and-compute-locally; the geofence-push design was built and superseded).

**Measured production populations (2026-08-27).** Quote Tool prod:
crew_members 8, shifts 14, shift_breaks 1, job_segments 0 ever,
job_assignments 0 ever, jobs 23, inventory_catalog 877, inventory_on_hand 0,
inventory_orders 0, job_stock_movements 0, vehicles 1, vehicle_events 6.
Reading: the office pipeline is used daily; the crew/time and stock foundations
are schema-and-code real but production-dormant. Anything built on them is a
first real use, not an extension of a proven system.

## 2. What is missing

- Advertising: everything. No role, no tables, no pages, no capture flow, no
  review flow, no pay summary. Nothing in the codebase knows the word.
- A safe third role: no positive allowlist mechanism generalizes past the
  bespoke crew carve-out. An `'advertising'` value in `app_metadata.role` today
  passes the perimeter and every `requireOperator()` gate as a full operator
  (about 150 routes, customer PII included), because `roleOf` collapses any
  non-admin value to operator and only crew is explicitly excluded.
- Crew My Day: no routes (the `/api/ops/v1` namespace is empty), no
  my-jobs-today endpoint, no time-of-day on `job_assignments` (date only), no
  prep-notes field anywhere, no crew-facing page, no browser time-status
  endpoint.
- Admin view switching: no role-based nav or view-switch mechanism exists at
  all; every operator sees the same nav.
- Per-unit inventory: no way to track sign #5012 as issued/placed/recovered.
- The call bridge: no `call_commitments`, no review lifecycle, no display of
  copilot scores or promises anywhere in this app.
- Payroll output: no payout, hours report, or efficiency screen; blocked on the
  seed-rates session by design.
- A time-exceptions UI (the API is done).

## 3. What should be reused

- The Inbox as the office MESSAGE queue, unchanged. This audit first
  recommended against a separate Office Tasks system; Naldo reversed that on
  2026-08-27 after the Call Copilot teardown, and the reversal is right: call
  commitments need a container, and the Quote Tool's follow-up strip is one
  quote-send reminder, not a task list. Office Tasks (built and tested in the
  copilot repo, its tables never applied to production) moves across as the
  single task list, fed by three sources: manual entry, extracted call
  commitments, and the follow-up strip. It matches the durable-tasks spec the
  plan doc already carries (24-hour default due, open/blocked/completed/
  dismissed, required reasons, idempotent, audited). Moving across means
  porting through this repo's conventions and gates, not copy-paste.
- `crewAuth.ts` wholesale for My Day auth: session to pay identity, fail
  closed, refuses operator sessions. The biggest ready-made piece.
- The crew/time ledger and its money math as the only time system. My Day and
  Telegram write the same rows keyed on `crew_member_id`; both channels already
  resolve to one identity (`auth_user_id` and `telegram_user_id` are separate
  columns on the same `crew_members` row).
- The schedule surface plus `job_assignments` as the source for "my jobs
  today"; `AssignmentRefusedError` already blocks office staff from field
  assignment.
- The staff panel (`StaffAccounts`) for onboarding: it already mints crew
  logins and links Telegram; an advertising creation door should mirror it.
- The fleet-GPS patterns for advertising evidence: raw-capture append table,
  content-hash webhook dedup, write-time privacy tagging, one-open partial
  uniques, and poll-and-compute-locally for anything geofence-shaped.
- Storage: a new private bucket with path-on-row and signed URLs, exactly like
  `designs` and `archive_photos`. Never inline base64, never public URLs.
- Geocoding plumbing (`propertyGeocode.ts` Google client) for reverse lookup;
  the `geofenceAnchorRefusal` gate stays for property anchors specifically.
- Conventions checklist for every new table: integer cents, timestamptz, RLS
  on with zero policies, partial-unique open-row guards, CHECK constraints
  tying required fields to state, `is_test` from day one, `updated_at` trigger
  in the same migration, FULL-SCHEMA.sql updated in the same PR.
- Epic #217 as the calls vehicle: it is already designed with binding
  acceptance criteria; do not redesign it from scratch.

## 4. What must not be copied from old Ops Hub work

- The deleted contract (`OPERATIONS_HUB_CONTRACT.md`) and its flows as build
  specs. Its stale mirror still sits in the yll-call-copilot repo; treat as
  history.
- Phone-OTP auth, Twilio Verify, Turnstile, Cloudflare auth, Railway. All out.
- The Hub's identity schema: `ops_departments`, `ops_employees`, and five more
  `ops_*` tables sit live in the copilot Supabase project (and a staging clone)
  with a handful of rows. They are the scrapped separate-identity model; the
  Cool Tool's `crew_members` plus the shared auth store is the identity system.
- The `yll-ops-hub-staging` Supabase project (created 2026-08-20, still
  active): a third live project from the scrapped direction. Nothing should
  build against it.
- The deleted `/api/ops/v1` job routes as-is. Reading them in git history as a
  reference is fine; they were removed as the external contract surface, not
  because the logic was wrong.
- `crew_members.hub_employee_id`: a nullable link to the dead external Hub.
  Harmless, but nothing new should read or write it.

## 5. Role and permission risks

1. **The operator collapse (the one that bites first).** `roleOf` returns
   'operator' for anything not exactly 'admin'; the perimeter's only role
   branch checks crew specifically. A new role is a full operator until it is
   explicitly carved out. The fix pattern exists (the crew marker) and the
   exclusion must land in `getOperator()` and `src/proxy.ts` BEFORE the first
   advertising account is minted, same as the crew comment already warns.
2. **The generic account door is safe; a cloned staff door is the risk.**
   `accountGuards.ts` hard-rejects unknown roles at creation, so an
   advertising login cannot be created through `/api/admin/users` by accident.
   The danger is cloning `/api/admin/staff`'s field-crew branch without its
   crew-specific safety checks (metadata self-check, escalation refusal in the
   users PATCH/DELETE route).
3. **The crew precedent is unexercised.** `requireCrew` has zero live route
   consumers and `/api/ops/v1` is empty, so the one restricted-role pattern has
   never been proven against a real route. The first My Day route should be
   verified with a real crew login, logged out, and as an operator.
4. **A prefix allowlist is a blanket grant.** Anything placed under the crew
   (or future advertising) path prefix becomes reachable by that role. Every
   route added there must be deliberately role-safe, and the AGENTS.md rule
   (allowlist in the same PR, verify logged out) applies double.
5. **No role-based nav exists.** Hiding advertising status from office users,
   and office surfaces from advertising users, is new plumbing on every
   relevant page, not a tweak to an existing mechanism.
6. **Three role systems already coexist** (OperatorRole admin/operator, the
   CREW_ROLE marker, and the Telegram bot's own BotRole table). Advertising
   adds a fourth population. Keep it a marker like crew; do not widen
   `OperatorRole`.
7. **Small trap:** `/api/auth/session` reports `signedIn:false` for a live
   crew session (it asks getOperator). Any crew or advertising page that
   reuses it will misread login state.

## 6. Recommended information architecture

- Office/Operator: the existing tool, unchanged. Schedule earns a nav slot when
  scheduling becomes real (Naldo's call).
- Admin: everything office has, plus the existing admin-only settings panels,
  plus (new) the Advertising review section and a view-switch control to open
  the Crew My Day and Advertising worker views for testing. Admin stays Naldo
  and Jason only.
- Crew/Installer: one restricted "My Day" page tree (proposal: `/crew`) plus a
  crew API namespace (proposal: `/api/crew/**`, a fresh prefix rather than
  reviving `/api/ops/v1`, so the new surface does not inherit assumptions from
  the deleted contract namespace). Telegram remains the primary crew channel.
- Advertising: its own page tree (proposal: `/advertising`) and namespace
  (`/api/advertising/**`), gated by a new `ADVERTISING_ROLE` marker, invisible
  to office by default, with the admin review screens living under the admin
  side, not the worker side.
- Calls: the merged coaching surfaces (feedback cards, call review browser,
  scoreboard, practice room) plus the one task list. Commitments surface as
  tasks, never a separate promises screen. Exact nav placement is the
  merge-plan session's job.

## 7. Recommended build order

1. Role hardening (small, first regardless; must precede any advertising
   account existing).
2. Calls merge, per the teardown and Naldo's priority ruling: the read-only
   HighLevel transcript probe first, then a dedicated merge-plan session, then
   Office Tasks as the container, then the grading pipeline.
3. Admin view-switch plus the minimal role-aware nav mechanism.
4. Advertising schema plus worker capture flow (photo + GPS + reverse-geocode
   suggestion), pay math test-first at $2.50 per accepted sign in cents.
5. Admin review flow (accept/reject/bulk accept, address correction), then
   worker earnings views, then duplicate-detection aids.
6. Crew My Day read-only slice, then actions (arrive/depart/complete) reusing
   the ledger.
7. Sign inventory per-unit tracking (phase 2, after placements prove the
   workflow; signs ride as a catalog SKU with manual reconciliation until then).

## 8. Workstreams

**A. Office/Admin foundation.** Role hardening, view switching, small office
polish (time-exceptions UI, stale-invoice discoverability, Schedule nav
decision). Owner surface: admin.

**B. Advertising.** Schema, capture, review, pay summaries, duplicate
detection, sign SKU. The only net-new product area. The worker view must show
pending estimated earnings (pending placements times the rate), accepted earned
amount so far, daily and weekly earnings, and rejection reasons on the worker's
own rejected placements. Duplicate detection is review-time tooling for admin,
never an automatic block: flag candidates by comparing nearby GPS points, the
exact suggested address, campaign, and worker-plus-day, show the proof photos
side by side (photo similarity can assist later), and let admin decide, because
several signs can legitimately stand near one intersection.

**C. Installs / Crew My Day.** Optional app view over the existing ledger;
Telegram stays primary. Needs two small schema additions (assignment start
time, prep notes) before it can show what the plan promises.

**D. HighLevel Calls (rescoped 2026-08-27 by the Call Copilot teardown).**
Merge the copilot's keep-list into the Cool Tool and retire the copilot:
the grading pipeline steps 1 through 7 (HighLevel recording sync, transcript,
junk gate, outcome labeling, rubric scoring, rep feedback cards, weekly
rollups), Office Tasks as the one task list with commitments as a source,
practice room, scoreboard, the personal-details scan, and maybe the call
queue (only if it feeds the Inbox). Cut: everything live-call (Twilio,
softphone, media bridge, phone login), call console, screen pop, contact
search, the rest of the second mile. Fresh tables in the Quote Tool database,
no data migration. The Quote Tool's cron infrastructure owns the timers the
copilot always left off. Epic #217's commitment extraction survives inside
this scope, but its display design (Telegram digest surfaces) is superseded
by the task-list ruling; its binding money/audit criteria still apply. The
HighLevel transcript endpoint may replace Deepgram, unproven until the probe
runs.

## 9. First PR-sized slice per workstream

- **A:** the role-hardening PR. `ADVERTISING_ROLE` constant plus
  `isAdvertisingAccount()`, exclusion inside `getOperator()`, a perimeter
  branch plus `isAdvertisingPath()` (empty allowlist for now), the
  advertising-refusal mirror in `/api/admin/users/[id]` PATCH/DELETE, and
  negative-control tests that watch each guard fail when removed. No UI, no
  accounts minted. This PR is the precondition for workstream B.
- **B:** the schema PR. `advertising_campaigns`, `advertising_placements`
  (own lat/lng/accuracy/captured_at, photo path, suggested_address,
  route/neighborhood text, status CHECK tying required fields to state,
  optional property_id), `advertising_activity` (append-only audit), the
  private `advertising-proof` bucket, integer-cents rate config, `is_test`,
  FULL-SCHEMA.sql in the same PR. Data layer plus tests, no UI.
- **C:** one read route and one page. `GET /api/crew/today` (requireCrew,
  returns the caller's assignments and time state) plus a minimal `/crew` page
  behind the crew marker, page allowlisted in the proxy, verified with a real
  crew login, logged out, and as an operator. Uses date-level assignments as
  they are; start-time/prep-notes columns come in the next slice.
- **D:** the read-only HighLevel transcript probe. A paste-able script using
  the copilot's GHL credentials against ONE completed YLL call, no writes:
  does the message export return the call, does the transcription endpoint's
  media channel separate rep from customer, and does the newer API version it
  requires break anything the sync uses. Its answer shapes the merge plan
  (Deepgram stays or goes), so it runs before the merge-plan session writes
  any slices.

## 10. Database tables likely needed

New: `advertising_campaigns`, `advertising_placements`,
`advertising_activity`, later `advertising_runs` if campaigns need
sub-batches, later `inventory_items` (per-unit sign tracking, phase 2), and
the calls-merge set (Office Tasks tables, recordings/transcripts/scores/
feedback cards, commitments-as-tasks; the exact set is the merge-plan
session's deliverable, fresh tables, no data migrated). Column additions:
`job_assignments.start_time` (nullable) and a prep-notes field (location to be
decided: `jobs` or `job_assignments`) for My Day; a per-sign rate setting
(app_settings or a rate column on campaigns) in cents. Worker identity is a
question for Naldo (section 13) before any advertising table references
`crew_members` or a new table.

## 11. Routes and pages likely needed

Workstream A: no new pages; a view-switch control in the existing shell.
Workstream B: `/advertising` (worker home, capture, my placements, earnings),
admin review pages (map/list, placement detail, bulk accept), and
`/api/advertising/**` (capture upload, my-placements, earnings; admin
accept/reject/correct). Workstream C: `/crew` (My Day) and `/api/crew/**`
(today, time status, later arrive/depart/complete). Workstream D: per #217
(bot/digest surfaces first, a small review UI later). Every new page and route
lands in the proxy/operatorGate allowlists in the same PR and is verified
logged out, per the standing pitfall.

## 12. Tests and verification

- Negative-control every new role guard: remove the guard, watch exactly the
  intended test fail, restore (the repo's standing practice).
- Money test-first: the $2.50-per-accepted-sign math in integer cents,
  including rejected-then-resubmitted-then-accepted counting exactly once,
  bulk accept idempotency under retry, and pay never counting pending or
  rejected placements.
- CHECK-constraint probes: a rejected placement without a reason and an
  accepted placement without a photo must both refuse at the DB.
- Perimeter tests per population: for each of operator, crew, advertising, and
  logged-out, assert reachability of one route in each namespace (the matrix
  the current code has never had).
- A real-device capture check: GPS accuracy and photo upload from an actual
  phone before the flow is called working; reverse-geocode suggestions
  verified against a handful of known addresses.
- My Day dual-channel test: clock in via Telegram, read state via the web
  route, and the reverse; the TOCTOU note in `shiftBreaks.ts` gets a fresh
  look once two concurrent channels exist.
- Prod verification for anything touching live surfaces, per AGENTS.md gates
  (tsc, lint, vitest, CI green, lens reviews at the tier the paths dictate).

## 13. Questions for Naldo before code is written

1. **Who are advertising workers?** Same people as crew (then a flag on
   `crew_members`, like `is_office`) or a separate population (gig/1099, then
   their own table sharing only the auth store)? This decides the schema and
   cannot be derived from code.
2. **Sign locations:** placements will often not be customer properties.
   Confirm placements stand alone (own GPS and suggested address, optional
   link to a property when it is one).
3. **The two leftover Supabase projects:** ANSWERED 2026-08-27. Retire the
   copilot repo, the copilot Supabase project, and `yll-ops-hub-staging` after
   the merge lands; export snapshot first.
4. **Schedule:** should `/admin/schedule` get its nav slot now? My Day depends
   on office actually creating assignments (`job_assignments` has never held a
   row).
5. **Seed-rates session:** still required before any pay number (crew or
   advertising efficiency views) can display. When?
6. **Calls scope:** ANSWERED 2026-08-27 by the Call Copilot teardown. The
   copilot does not stay separate; its keep-list merges into the Cool Tool
   (workstream D) with fresh tables and no data migration, and calls are the
   first build after role hardening.
7. **Per-sign rate changes:** when the $2.50 rate changes later, do already
   accepted placements keep their historical rate (recommended: stamp the rate
   on the placement at acceptance) or repay at the new rate?
8. **Sign inventory timing:** confirm phase 2 (catalog SKU plus manual
   reconciliation first); per-unit tracking only after placements prove the
   workflow.

## Proposed ledger rows (numbers claimed at the close sync, not here)

- Workstream A slice 1: role hardening for the advertising population (the
  precondition PR; constraints from section 9A written into the row).
- Workstream B slice 1: advertising schema plus data layer (constraints:
  cents, CHECK-tied states, private bucket, is_test, FULL-SCHEMA same PR).
- Workstream C slice 1: crew My Day read slice (constraints: new namespace,
  requireCrew, logged-out verification, no payroll display).
- Workstream D slice 1: the read-only HighLevel transcript probe, then the
  calls merge-plan session (row 217 gets a pointer note: superseded-in-part by
  the teardown's task-list ruling).
- Cleanup row: retire the copilot repo, the copilot Supabase project, and
  `yll-ops-hub-staging` after the merge lands (ruled 2026-08-27), with a
  one-time export snapshot of transcripts/scores/learnings taken first.
