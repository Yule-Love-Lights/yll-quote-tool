# Operations Hub <-> Quote Tool contract, v1.3.0-draft

> CANONICAL copy. The mirror lives at
> `yll-call-copilot/docs/operations-hub/INTEGRATION-CONTRACT.md` and must carry
> the same version string. Neither repo builds against anything not in this
> file. Built 2026-08-06 from CODEX-PLAN §19-21, OPERATIONS-HUB-SPEC §3-§7,
> CLAUDE-PLAN A3/A8, the union checklist from the cross-doc gap audit, and
> Naldo's rulings R1-R8 + F1-F4 (DECISIONS.md in the hub repo). Approved by the
> Claude/Quote Tool side as v1.3.0-draft; becomes v1.0.0 when Codex confirms
> the mirror matches and Naldo approves the master plan.

## 0. Ownership (final, per rulings F2/R8)

- **Quote Tool owns:** customers, jobs, addresses, schedule, assignments,
  budgeted hours, labor revenue, ALL canonical time (day clock, breaks, job
  segments, travel, as one paid-day envelope), approvals and payroll locks,
  completion state and photo binaries, the whole P4P engine, payroll export,
  compensation config, the Telegram bot, and every shared-labor schema
  migration plus the `/api/ops/v1` routes (single author: the Quote Tool
  assistant).
- **Hub owns:** phone-OTP auth, employee profiles/roles/department
  memberships, sessions, the office/call tools, ALL advertising (campaigns,
  runs, placements, numbering, media, hotspots), raw route breadcrumbs and
  device evidence, offline command queues, read-model caches, hub audit
  events, and the hub schema (single author: Codex).
- The Hub is capture UI and projection for time; it never holds mutable
  canonical time and never computes pay (F2, R8).

## 1. Transport and envelope rules (every flow)

- TLS; environment-scoped machine credentials per direction; replay
  protection (signed timestamp+nonce); key rotation; request-size limits;
  service keys never in a browser.
- Every mutation carries: acting `employee_id`, `idempotency_key`,
  `device_time` + timezone, `source` (`pwa` | `telegram` | `office` |
  `system`), app/device version, optional GPS + accuracy, `expected_version`,
  optional reason/evidence.
- Every response returns: canonical id, accepted server time, state enum,
  new version, review flag, safe error code.
- Same key + same payload returns the original result. Same key + different
  payload is rejected. Dedupe keys are retained at least 45 days (covers
  offline retry windows), retention recorded here.
- Transactional outbox on the writer, inbox dedup on the reader, aggregate
  versions with stale-version rejection, correlation and causation ids,
  retry with backoff, dead-letter queue WITH an admin surface in both apps.
- UTC storage; America/New_York for display, business days, and the weekly
  pay boundary. Integer cents everywhere; no floats.
- Pagination on every list endpoint; versioned paths (`/api/ops/v1/...`);
  deprecation runs old+new in overlap with a dated retirement; rollback
  semantics stated per endpoint at implementation time.
- Each implemented endpoint ships a formal OpenAPI fragment in the PR that
  builds it, appended to this contract's spec directory.
- Every crew-reachable Quote Tool route enters `operatorGate`'s allowlist in
  the same PR, verified logged out. Hub field launch requires RLS enabled and
  tested; production fails closed.
- Independent kill switches: QT time-writes, QT job-reads, completion
  commands, Telegram relay, hub advertising writes, route collection.
- **Vocabulary (v1.1.0, from the risk audit): three distinct version fields,
  never the bare word "version":** `contract_version` (this file's semver),
  `client_app_version` (the calling app/device build), `entity_version` (the
  per-aggregate optimistic-concurrency counter; `expected_entity_version` on
  requests). `review_flag` enum: `none` | `needs_review` | `quarantined`.
  Error-code enum (extendable only by contract PR): `unauthorized`,
  `forbidden`, `not_found`, `conflict_stale_version`,
  `conflict_idempotency`, `validation_failed`, `gate_locked`,
  `kill_switched`, `rate_limited`, `internal`.
- **One shared schema artifact.** The envelope, enums, and event shapes are
  published as a versioned JSON Schema (generated from the OpenAPI
  fragments); BOTH repos validate requests and responses against the same
  schema file in their own CI. Neither side hand-implements the envelope
  twice. A CI check in each repo fails on any byte diff between the
  canonical contract and the mirror, version string included.
- **Deploy skew guard:** each side's deploy runs a staging smoke against
  every `/api/ops/v1` endpoint and fails on `contract_version` disagreement.
  The two repos auto-deploy independently; this is the only gate.
- **Dead-letter alerting:** DLQ depth greater than zero pushes a Telegram
  alert to Naldo and Jason through the existing QT bot. The admin surface is
  the workbench, never the only detection mechanism.

## 2. Identity (Flow I)

- Immutable mapping, one row per person: hub `employee_id` (canonical) <->
  QT `crew_members.id` <-> phone <-> `telegram_user_id`. Runtime linkage
  never by name or email text.
- Hub emits `EmployeeUpserted` (employee_id, display_name, department
  memberships[], role, active, telegram_user_id?, language) and
  `EmployeeDeactivated` (employee_id, at, reason; also kills Telegram
  pairing and integration credentials).
- QT `crew_members` additionally holds the pay-side fields (QT truth):
  `base_rate_cents`, `in_p4p_pool`, `pay_mode` (`hourly`|`shadow`|`p4p`),
  `language`. `hub_employee_id` is nullable until Hub Phase 0 lands, then
  backfilled; partial provisioning is labeled and retried, never a silent
  duplicate.
- Departments are MEMBERSHIPS (one or more per employee, per ruling R7) with
  ONE active department context per shift.
- **Interim identity rule (unblocks the Sept 21 Track A target):** until Hub
  Phase 0's OTP lands, `employees` rows may be ADMIN-SEEDED (Naldo/Jason
  create the five people without OTP sign-in), or Flow B commands originating
  from the Telegram bot authenticate by `telegram_user_id` and act under
  `crew_members.id` as the acting identity, backfilled to `hub_employee_id`
  later. Track A does NOT depend on the OTP UI shipping. Stated here so it is
  never rediscovered mid-season.
- **Deactivation forces financial resolution.** `EmployeeDeactivated`
  triggers a QT final-pay checklist: unapproved time queued for final
  approval, pool shares computed at the final payroll, any open yellow-slip
  response window resolved per the comp plan. No silent limbo for in-flight
  pay.

## 3. Flow A: jobs and schedule reads (QT -> Hub)

- `GET /api/ops/v1/me/day` — the installer's day. Empty of sensitive detail
  until an accepted clock-in exists (the gate, F4): pre-clock-in it returns
  only the non-sensitive summary (date, start time, crew names, prep notes);
  post-clock-in it returns exact addresses, customer contact, route order,
  and job action affordances. Enforced server-side on every request; cached
  screens cannot bypass; office/admin roles exempt; the audited owner
  emergency override and the signed offline work packet ("Clock-in waiting
  to sync") are the only exceptions.
- `GET /api/ops/v1/jobs?assigned_to={employee_id}&date=` — job_id, customer
  display name, address (role-gated), lat/lng, window, assigned
  employee_ids[], budgeted_hours, canonical status, service type.
- `GET /api/ops/v1/jobs/{id}/design` (post-clock-in gated, v1.1.0, closes
  the installer-lens gap): signed design snapshot/render URL, the design's
  item list, a DERIVED LOAD LIST (materials from the design BOM), and
  job-site notes (gate code, dog, parking, surfaced from existing quote/
  customer notes). The design editor's geometry finally reaches the crew,
  not just the pay math.
- Jobs and me/day payloads carry `service_type`; a takedown job renders a
  visible "hourly mode" badge on every crew surface so a pool member never
  expects performance pay on takedown work.
- Jobs payload carries optional `sold_by_employee_id` so the hub can close
  the sales loop (notify the rep on field completion, feed the second-mile
  review/referral queue).
- Events: `JobAssigned`, `JobUnassigned`, `JobRescheduled`,
  `JobStatusChanged` (job_id, status, at, entity_version,
  sold_by_employee_id?).
- **Flow F (reserved, v1.2):** placement-to-lead attribution. Campaign
  short-codes/QR on signs and door hangers captured at call/lead intake
  (GHL tag or field), plus ROI read endpoints joining placements to quotes
  and bookings. Named now so neither side designs against it.

## 4. Flow B: time capture commands (Hub/Telegram/office -> QT)

The canonical ledger lives in the QT (F2). Capture surfaces submit commands;
the QT applies them to one paid-day envelope with non-overlapping segments.

- `POST /api/ops/v1/clock-in` · `POST /api/ops/v1/clock-out`
- `POST /api/ops/v1/breaks/start` · `POST /api/ops/v1/breaks/end`
- `POST /api/ops/v1/jobs/{id}/arrive` · `POST /api/ops/v1/jobs/{id}/depart`
- `POST /api/ops/v1/jobs/{id}/complete` (also requests operational
  completion, Flow C)

Semantics (state machine, QT-enforced):

- Clock-in opens the day envelope (GPS sample required, no geofence);
  clock-out closes any open segment/break at punch time and flags review.
- Arrive opens a job segment (`entry_kind = install` default; `rework` for a
  closed job, allowed, affects efficiency, never reopens billing;
  `non_billable` with approval). Depart closes it. Manual punches are
  AUTHORITATIVE for pay (F3).
- Break pauses job time and route collection; break end resumes the day,
  not the job.
- Travel = day time outside job/break/non-billable segments, counted once
  (single-source rule; no BH travel allowance double-count).
- `stoppage_reason` enum on segment close: `completed` | `weather` |
  `no_access` | `materials` | `other`. Ships day one; weather-flagged
  segments are excluded from the BH learning signal.
- Midnight (America/New_York) auto-closes forgotten days AND is independent
  of the Hub's Placement Run midnight reconciliation.
- Capture states visible to the employee: saved-on-phone, waiting-to-sync,
  accepted, needs-review, rejected.
- GPS-derived route evidence (Hub-owned) may SUGGEST visits after Phase 5
  calibration; a suggestion becomes a segment only through an explicit
  punch, an employee confirmation, or a Jason/Naldo correction (F3).
- **Missed-tap backstop (v1.1.0):** with manual punches sole-authoritative,
  a forgotten Depart is the one un-backstopped pay-and-data corruption
  path. The QT flags any open job segment with no activity beyond a
  configurable idle gap and the bot nudges the crew member same-day.
  "Forgotten mid-day tap" joins the Phase 4 failure-test list.

## 5. Flow C: canonical time reads, approvals, exceptions (QT surfaces)

- `GET /api/ops/v1/me/hours` — the employee's envelope: segments with
  entry_kind, breaks, travel, gaps, acceptance states, approved totals.
- Approval, correction, split, rejection, lock, reopen, and post-export
  adjustment are QT owner operations: Jason primary, Naldo backup, ONLY
  them (managers comment/recommend). Every edit is append-only with
  before/after, actor, reason. Exported periods change by adjustment rows
  in the next period, never rewrite.
- Exception queues (QT): forgotten clock-out, duplicate punch, open break at
  clock-out, open job segment at clock-out, overnight/DST, missing/poor GPS
  on punches, correction requests, unapproved-time-at-payroll-cutoff.
- Owner emergency override API: requester, approver, reason, start, expiry,
  affected employee, fully audited.
- Wage-feeding records (envelope, segments, approvals, pay ledger): SIX-YEAR
  retention, append-only. Raw route breadcrumbs (Hub): 120 days.

## 6. Flow D: operational completion

- `jobs/{id}/complete` stores a NON-financial state, names locked from
  CODEX-PLAN §19: `field_work_completed` or
  `completion_submitted_for_office_review`. Emits `JobStatusChanged` back.
  NEVER touches invoices, deposits, or money. One canonical operation for
  PWA, Telegram, and office (extends the existing bot `completeInstall`).
- Completion photos post through the QT's existing photo path; commands
  carry returned reference ids; the binary exists once. Required photo
  count/camera/GPS rules stay OFF until Naldo defines them (Codex open item).
- **Material fields pinned (v1.1.0, no more spec-by-assumption):** the
  complete command preserves today's bot `completeInstall` shape:
  `materials_used[]` ({sku, qty, estimated_qty?}), optional on-hand true-up,
  `note?`, `photo_refs[]`, raw text for audit. Same fields on every channel.
- On `field_work_completed`, if the job carries `sold_by_employee_id`, the
  hub notifies the selling rep ("your sale is installed") and the QT
  enqueues the review/referral follow-up (second-mile pattern).

## 7. Flow E: earnings, stats, leaderboard (QT -> Hub display)

- `GET /api/ops/v1/me/earnings?period=` returns per period: base_pay_cents,
  hours breakdown, `pool_share_provisional_cents`,
  `pool_share_earned_cents`, per-job `quality_window_closes_at`,
  `floor_true_up_cents`, bonuses[] (training +$4/hr, referral, manual
  adjustments), forfeitures[] (job, documented reason, employee response
  state), pay_mode, and the week-N hours / week-N-1 performance split.
- **Display law (binding, CLAUDE-PLAN A3):** provisional renders EXACTLY as
  `Pending quality review` with its close date. Never earned/made/owed/paid,
  never in earned totals, exports, or leaderboards. The server supplies
  states and timestamps; the Hub never infers or computes them. Only
  `earned` enters payroll export. Quality transitions are race-safe
  (server-side compare-and-swap on state), evidence immutable, employee
  response step included, Jason/Naldo finalize.
- `GET /api/ops/v1/me/stats` (efficiency, BH vs actual, trend) and
  `GET /api/ops/v1/leaderboard` (approved team metrics; no pay amounts, no
  addresses, no routes on internal-public boards).
- Engine guarantees restated as contract: integer cents, largest-remainder
  split with remainder cents to the crew, pool computed at invoice-final
  (never quote approval; never-invoiced jobs pay no pool), conservative
  default labor % for unmapped item categories, floor-true-up alarm that
  holds the pay flip, shadow mode until the per-person pay-mode flag flips,
  written comp plan + NY WTPA pay-rate notice (employee's language) before
  any individual's flip.

## 8. Flow T: Telegram relay

- The QT bot is the single ingress (one bot, one webhook, R4). Job/time/pay
  commands hit the same `/api/ops/v1` operations with `source: telegram`,
  the shared idempotency rules, update_id dedup, and reply-bound
  confirmations for consequential writes.
- Advertising over Telegram in v1: status + deep link into Hub Camera Mode
  only. Run start/end and placement capture are Hub-only; Telegram photos
  are never verified placements.
- Pairing, roster, routing, webhook config, write enablement: Naldo/Jason
  only, audited.
- **Relay latency SLA (v1.1.0):** a crew member's consequential command gets
  an interim "Got it, processing" bot reply within 2 seconds and a final
  confirmation on completion; re-taps ride the idempotency key. A slow or
  down QT never leaves someone standing in the cold re-tapping into
  silence.

## 8b. Flow G: advertising pay inputs (v1.2.0, per Naldo's piece-rate ruling)

- The advertising crew is paid **$2.50 per accepted placement** (rate lives in
  QT compensation config, changeable), computed by the QT pay engine ONLY
  (R8), with the standard floor true-up: weekly pay = max(accepted placements
  x piece rate, hours x the legal floor). NY minimum wage applies to
  piece-rate hourly averages, so the ad crew joins the SAME day clock as
  everyone else (Flow B clock-in/out; advertising's exclusion from attendance
  is repealed by this ruling). Placement Runs remain productivity sessions;
  the day clock is the hours record.
- Hub reports pay inputs weekly: `AdvertisingWeekClosed` event per employee
  per week: accepted placement count (verified placements only, voids
  excluded), campaign breakdown, signs issued, signs reconciled
  (issued - placed - returned), entity_version. The QT computes pay from the
  COUNT; the sign-inventory reconciliation informs restock and loss review,
  never a wage deduction (NY §193 applies to the ad crew too).
- Sign inventory ledger is Hub-owned (advertising domain): stock on hand,
  weekly issuance per person, placement decrements, week-end reconciliation.
- Piece-rate pay basis requires its own written comp terms and WTPA notice,
  same as the installers' P4P (attorney reviews both in one pass).
- Digest model (Naldo's ruling): FOUR per-department digests (office,
  advertising, install, management), each combining that department's ops
  and attendance; admins receive all four. The QT morning ops digest and the
  hub coaching digest fold into this model; digest content APIs follow the
  same provisional-pay display law.

## 9. Sequencing hooks (F1)

Joint Phase 0 delivers: this contract as OpenAPI stubs, identity mapping,
auth/audit/idempotency scaffolding, kill switches, AGENTS.md ownership rows.
Then in parallel: Track A (QT: crew_members, BH + labor revenue, canonical
time ledger + bot capture targeting Sept 21, scheduling calendar, approvals
and exceptions, P4P shadow engine, earnings API), Track B (Hub advertising
PWA), Track C (Hub office/install UI: rename, OTP, gate summary screens,
manual punch UI, completion UI). Actual P4P pay enablement is last and
feature-flagged. External Copilot CRM cancels only after schedule/time
parity plus two clean weeks; YLL Call Copilot the codebase is preserved and
renamed.

## 9b. v1.3.0 amendments (accepted from CONTRACT-V1.3-PROPOSAL.md, 2026-08-07)

Codex's P1-P15 proposal sections are ACCEPTED and normative as follows.
Dispositions: P1-P5, P7-P15 accepted; P6 accepted with one clarification;
P16 is the open-decision list and lives with DECISIONS.md. Where this section
and the flows above differ in field naming, this section wins; semantics
merge, never weaken.

- **P1 versions:** three values on every request/response and a health
  surface: `contract_version`, `schema_version` (the shared JSON Schema
  artifact's own version), `client_version`. Deploys fail on
  contract/schema incompatibility; CI byte-compares canonical vs mirror
  after canonical merge.
- **P2 envelope:** the canonical mutation envelope and response are the
  proposal's shapes (command_id, idempotency_key, **semantic_operation**
  `employee:date:operation:entity` protecting the same human action across
  channels, actor_employee_id, source, versions, device times,
  client_sequence, effective_at_requested, offline_packet_id,
  active_department_id + membership_version, gps_evidence, reason,
  evidence_refs, correlation_id; response: canonical_operation_id,
  command_status enum, effective_at, entity_version, review_flag,
  error_code, duplicate_of_command_id). Add
  `GET /api/ops/v1/commands/{command_id}` for post-timeout resolution.
  Error-code enum = the union of section 1's list and the proposal's
  additions (CONTRACT_VERSION_UNSUPPORTED, SCHEMA_VERSION_UNSUPPORTED,
  ENTITY_VERSION_CONFLICT, IDENTITY_NOT_LINKED, MEMBERSHIP_STALE,
  ACTIVE_DEPARTMENT_REQUIRED, CLOCK_REQUIRED, OFFLINE_PACKET_EXPIRED,
  OFFLINE_PACKET_SCOPE_DENIED, EFFECTIVE_TIME_REVIEW_REQUIRED,
  PLACEMENT_ACK_PENDING, INVENTORY_RECONCILIATION_REQUIRED,
  PAY_PERIOD_LOCKED).
- **P3 identity:** admin-seeded `crew_members` start Track A; QT never
  creates or mutates Hub employees; owner-only
  `POST /api/ops/v1/identity-links` with optimistic versioning; events
  IdentityLinked/Changed/Unlinked; duplicate phone/Telegram/employee links
  hard-fail into an owner review queue.
- **P4 departments:** one `active_department_id` per paid shift; ClockIn
  requires it plus membership_version;
  `POST /api/ops/v1/me/department-context/switch`; switching during an open
  break/segment/run defaults to reject-with-review until Naldo rules
  (P16.2); DepartmentContextChanged event; no retroactive reclassification.
- **P5 offline packets:** signed scoped `POST /api/ops/v1/me/offline-packets`
  (employee, day, allowed operations, issued/expires, versions, nonce);
  drift/GPS-age/sequence limits are P16.1 launch config; missing GPS
  review-flags, never erases or fabricates; server persists device time,
  receipt time, requested and chosen effective time, and the chooser.
- **P6 time (accepted with clarification):** semantic operations clock_in,
  break_start/end, arrive_job, depart_job, travel_start/end,
  non_billable_start/end, clock_out. Unsegmented day time returns as
  `unclassified_seconds`; the Hub never infers travel. CLARIFICATION
  (preserves Naldo's drive-time ruling): travel remains PAID day time inside
  the envelope; explicit travel ops or an approved classification rule
  assign it; the unclassified residual exists to surface missed taps, not to
  unpay time. Typed exceptions and correction-request endpoints as proposed;
  locked periods adjust forward only. The six-year wage-record retention in
  section 5 stands unchanged.
- **P7 job facts:** assignment reads add budgeted_elapsed_hours,
  planned_crew_size, budgeted_crew_hours, job_lead_employee_id,
  assigned_crew[] with roles, design/load-list refs, notes, gate state,
  source version. Pre-clock responses omit sensitive fields and action
  tokens. Audited emergency override as specified.
- **P8 completion:** two dimensions: `field_work_state`
  (not_started | in_progress | field_work_completed) and
  `completion_review_state` (not_submitted |
  completion_submitted_for_office_review | accepted | needs_changes);
  `depart_behavior` on the command; pinned material fields unchanged;
  offline completion drafts with checksum media manifest and
  durable-before-submit; events FieldWorkCompleted,
  CompletionReviewChanged, JobDeparted; never financial.
- **P9 quality and deactivation:** employee-readable quality-case API
  (evidence, reason code, response state/deadline, reviewer, window close);
  `GET /api/ops/v1/crew/{id}/deactivation-readiness` listing every open
  item before deactivation; retained final-pay/audit records never deleted.
- **P10 placement events:** PlacementAccepted / PlacementReversed
  (/ PlacementAcceptanceCorrected) with the proposal's field list; batch
  delivery with per-event acks; QT dedupes by event id; reconciliation read
  comparing Hub vs QT totals by employee/campaign/week.
- **P11 advertising weeks:** week states open ->
  submitted_for_reconciliation -> ready_to_close -> closed -> adjusted;
  close blocked while events/links/inventory unresolved;
  AdvertisingWeekClosed carries the full proposed field list;
  compensation config effective-dates the rates, initial values **250
  cents per accepted placement, 1700 cents/hour floor**; QT computes and
  returns unit pay, floor comparison, true-up, total, blockers; inventory
  variance is never a wage deduction; door-hanger pay stays unconfigured
  until ruled.
- **P12 office metrics:** versioned effective-dated qualified-call formula;
  stat reads expose numerator/denominator/exclusions/source-through/formula
  version; sold_by uses immutable identity with an owner correction flow;
  never name-matching.
- **P13 digests:** four types (office, advertising, install, management);
  canonical facts endpoint or event bundle per type/period with
  source-through and versions; Hub composes and delivers; persisted digest
  records with input versions, recipients, artifact checksum, delivery
  state; admins receive all four; display law applies; scheduled delivery
  has its own deadline/retry policy distinct from the 2-second command SLA.
- **P14 payroll:** QT-owned readiness/blocker read, owner close/lock, raw
  CSV generation, post-export adjustment listing; blockers as proposed; CSV
  carries no provisional values, one row per pay line with stable ids and
  types (hourly base, installer performance earned, advertising piece rate,
  floor true-up, training bonus, referral bonus, manual adjustment);
  vendor column mapping is an owner/payroll decision; QuickBooks out of V1.
- **P15 observability:** stable event ids, at-least-once outbox with
  idempotent consumers, DLQ metrics (depth, oldest age, operation, last
  error) alerting through the QT bot, reconciliation jobs for every event
  family, replay never duplicates effects.

**Shared schema artifact path (planned, Phase 0):**
`yll-quote-tool/docs/context/ops-contract-schema/` (generated from the
OpenAPI fragments; `schema_version` lives in its manifest; both CIs validate
against it and the Hub vendors the same files byte-identically).

## 10. Change process

1. PR against this file (and the mirror in the same or a paired PR) BEFORE
   or WITH the implementation.
2. Both assistants named reviewers; a human merges.
3. Money movement, ownership changes, or display-law changes need Naldo's
   line in DECISIONS.md.
4. Version bumps: patch for additive fields, minor for new endpoints, major
   for semantics. Both repos must reference the identical version before
   either builds against a change.
