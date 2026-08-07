# Operations Hub <-> Quote Tool contract, v1.0.0-draft

> CANONICAL copy. The mirror lives at
> `yll-call-copilot/docs/operations-hub/INTEGRATION-CONTRACT.md` and must carry
> the same version string. Neither repo builds against anything not in this
> file. Built 2026-08-06 from CODEX-PLAN §19-21, OPERATIONS-HUB-SPEC §3-§7,
> CLAUDE-PLAN A3/A8, the union checklist from the cross-doc gap audit, and
> Naldo's rulings R1-R8 + F1-F4 (DECISIONS.md in the hub repo). Approved by the
> Claude/Quote Tool side as v1.0.0-draft; becomes v1.0.0 when Codex confirms
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
- Events: `JobAssigned`, `JobUnassigned`, `JobRescheduled`,
  `JobStatusChanged` (job_id, status, at, version).

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

## 10. Change process

1. PR against this file (and the mirror in the same or a paired PR) BEFORE
   or WITH the implementation.
2. Both assistants named reviewers; a human merges.
3. Money movement, ownership changes, or display-law changes need Naldo's
   line in DECISIONS.md.
4. Version bumps: patch for additive fields, minor for new endpoints, major
   for semantics. Both repos must reference the identical version before
   either builds against a change.
