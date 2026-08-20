# Operations Hub <-> Quote Tool contract, v1.4.0-draft

> Canonical authority resides at
> `yll-quote-tool/docs/context/OPERATIONS_HUB_CONTRACT.md`. The byte-identical
> mirror resides at
> `yll-call-copilot/docs/operations-hub/INTEGRATION-CONTRACT.md`.
>
> This file is the complete normative contract. Historical Hub plans,
> proposals, and decision logs are provenance only. Implementations may
> additionally consume only the OpenAPI and JSON Schema artifacts explicitly
> generated from this file. The draft becomes `v1.4.0` only through the paired
> review and human-approval process in section 10; it is never renumbered
> downward to `v1.0.0`.

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
- Every mutation and response uses the common command fields below plus the
  endpoint-specific payload fields defined by the relevant flow.
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
- **Vocabulary:** never use the bare word `version`. `contract_version` is
  this contract's semver, `schema_version` is the shared schema artifact's
  semver, `client_version` is the caller build, and `entity_version` is the
  per-aggregate optimistic-concurrency counter
  (`expected_entity_version` on requests).

### 1.1 Canonical command request

Every consequential mutation carries these common fields. A nullable field is
still present with `null` when it does not apply so all clients validate the
same shape.

```text
command_id                    UUID; one human intent, stable across retries
idempotency_key               string; stable for transport retries
semantic_operation           string; employee:date:operation:entity
actor_employee_id             UUID
impersonating_actor_id        UUID | null
source                        hub_pwa | telegram | office | admin | system
contract_version              string
schema_version                string
client_version                string
expected_entity_version       non-negative integer | null
device_occurred_at            RFC3339 timestamp
device_timezone               IANA timezone
client_sequence               non-negative integer
effective_at_requested        RFC3339 timestamp | null
offline_packet_id             UUID | null
active_department_id          UUID | null
membership_version            non-negative integer | null
gps_evidence                  object | null
reason                        string | null
evidence_refs                 string[]
correlation_id                UUID
```

`gps_evidence` contains latitude, longitude, `accuracy_meters`, captured-at
timestamp, and capture source. `idempotency_key` protects a transport retry;
`semantic_operation` protects the same human action arriving through another
channel. A duplicate returns the original canonical result and never creates a
second effect.

### 1.2 Canonical command response

```text
command_id                    UUID
canonical_operation_id        UUID
command_status                accepted | accepted_with_review | pending |
                              rejected | superseded
received_at                   RFC3339 timestamp
effective_at                  RFC3339 timestamp | null
entity_version                non-negative integer
review_flag                   none | needs_review | quarantined
error_code                    error_code | null
duplicate_of_command_id       UUID | null
contract_version              string
schema_version                string
client_version                string; echoed from the request
correlation_id                UUID
```

`pending` means durably received but not canonically applied. `accepted` means
the operation is canonical. `accepted_with_review` means it is canonical and
has a named exception. `rejected` creates no business effect. `superseded`
returns the prior operation through `duplicate_of_command_id`.

The closed `error_code` enum is extendable only through a contract PR:

```text
unauthorized
forbidden
not_found
conflict_stale_version
conflict_idempotency
validation_failed
gate_locked
kill_switched
rate_limited
internal
contract_version_unsupported
schema_version_unsupported
entity_version_conflict
identity_not_linked
membership_stale
active_department_required
clock_required
offline_packet_expired
offline_packet_scope_denied
effective_time_review_required
placement_ack_pending
inventory_reconciliation_required
pay_period_locked
```

`GET /api/ops/v1/commands/{command_id}` returns this same response shape so a
caller can resolve a timeout, offline retry, or Telegram interim reply.

### 1.3 Canonical event envelope

Every cross-repository event carries this complete envelope in addition to its
event-specific payload. `aggregate_id` is an opaque non-empty string because
some aggregates use internal UUIDs while others preserve an external system's
stable identifier. Consumers must not infer its type from the event name.

```text
event_id                      UUID
event_type                    non-empty string
aggregate_id                  non-empty string
entity_version                non-negative integer
occurred_at                   RFC3339 timestamp
effective_at                  RFC3339 timestamp
accepted_at                   RFC3339 server timestamp
actor_employee_id             UUID | null
source                        hub_pwa | telegram | office | admin | system
contract_version              string
schema_version                string
client_version                string
correlation_id                UUID
causation_id                  UUID | null
idempotency_key               non-empty string
```

`actor_employee_id` may be `null` only when `source = system`; every other
source requires the employee UUID. A system-produced event may retain a
non-null employee actor when the event was caused on that employee's behalf.
For a system-produced event, `client_version` is the emitting service's build
identifier. `causation_id` is the preceding command or event id when one exists,
otherwise it is explicitly `null`.

### 1.4 Machine request authentication

Every server-to-server request uses a direction- and environment-specific key.
The sender includes:

```text
X-YLL-Key-Id                  active rotation identifier
X-YLL-Timestamp               Unix epoch seconds
X-YLL-Nonce                   unpadded base64url, at least 128 random bits
X-YLL-Contract-Version        contract version sent by the caller
X-YLL-Schema-Version          independent schema version sent by the caller
X-YLL-Client-Version          caller build identifier
X-YLL-Signature               v1=<lowercase HMAC-SHA256 hex>
```

The HMAC input is UTF-8 bytes of this canonical string, with exactly one line
feed between fields and no trailing line feed:

```text
v1
<UPPERCASE HTTP METHOD>
<canonical path and query>
<X-YLL-Timestamp>
<X-YLL-Nonce>
<X-YLL-Contract-Version>
<X-YLL-Schema-Version>
<X-YLL-Client-Version>
<lowercase SHA-256 hex of the exact request-body bytes>
```

The canonical target is reconstructed from the untouched raw request target,
never from a framework-normalized URL. The sender and receiver apply this
byte-level algorithm and reject a raw target that is not already in canonical
form:

1. Split at the first `?`; fragments, control bytes, backslashes, malformed
   percent escapes, and non-UTF-8 escaped bytes are invalid. The path starts
   with `/`.
2. Remove exactly one required leading `/`. If nothing remains, the path is
   `/`. Otherwise split the remainder on literal `/`; empty segments, including
   a trailing empty segment, are invalid. Percent-decode each segment as UTF-8,
   reject `.` and `..` segments, decoded control bytes, and any decoded `/` or
   backslash, then RFC 3986 encode every byte except
   `ALPHA / DIGIT / -._~`. Percent hex is uppercase. Prefix `/` and rejoin the
   encoded segments with literal `/`.
3. Split a non-empty query only on literal `&`. Every pair contains `=` even
   for an empty value; empty pairs and literal `+` are invalid. Split each pair
   at its first `=`, percent-decode key and value as UTF-8, reject decoded
   control bytes U+0000 through U+001F and U+007F, and encode them with the same
   unreserved-byte rule. Sort by encoded key and then encoded value, preserving
   duplicate pairs, and join with `&`.
4. The signed target is the canonical path plus `?` and the canonical query
   when pairs exist. The receiver rejects the request unless this value is
   byte-identical to the raw request target.

Examples: `/api/ops/v1/commitment-events?limit=100&since=abc%2Fdef` is
canonical; the same pairs in reverse order are not. A literal `+`, lowercase
`%2f`, an encoded unreserved byte such as `%61`, a missing `=`, a dot segment,
double slash, or trailing slash is rejected. A request with no body uses the
SHA-256 digest of zero bytes. The OpenAPI security component carries public,
complete conformance vectors containing method, target, timestamp, nonce,
exact UTF-8 body, body digest, canonical multiline input, test-only key, and
expected signature. Both implementations run those vectors in their HMAC
tests before enabling a machine route.

All three version headers are part of the signed canonical input. The receiver
validates them before invoking the business handler and rejects incompatible
contract or schema versions with HTTP 409 and the typed, versioned
`contract_version_unsupported` or `schema_version_unsupported` error. A
request-header schema accepts any syntactically valid version so an unsupported
version reaches this comparison instead of failing as an untyped parse error. A
successful or business-level error response
echoes the caller's `client_version` and carries the receiver's
`contract_version` and `schema_version`. HTTP 401 is the sole exception to the
section 9b P1 response-version rule: authentication failed before the receiver
could trust or echo caller-controlled version fields, so it returns only a
generic unversioned authentication error.

The receiver resolves `X-YLL-Key-Id` only inside the request's environment and
direction, compares the signature in constant time, accepts timestamps within
plus or minus five minutes, and atomically rejects a reused nonce. Nonces are
scoped to environment, direction, and key id and retained for at least ten
minutes. Rotation may overlap active and previous key ids, but a key is never
shared across environments or directions. Missing, malformed, stale, unknown-
key, replayed, or invalid requests fail before business handlers run and return
only a generic authentication error.

- **One shared schema artifact.** The envelope, enums, and event shapes are
  published as a versioned JSON Schema (generated from the OpenAPI
  fragments); BOTH repos validate requests and responses against the same
  schema file in their own CI. Neither side hand-implements the envelope
  twice. A CI check in each repo fails on any byte diff between the
  canonical contract and the mirror, version string included.
  The initial independent `schema_version` is `1.0.0-draft`; it does not inherit
  or mirror the contract version.
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
- Hub emits `EmployeeUpserted` carrying `employee_id`, display name, role,
  active state, optional Telegram id, language, `membership_version`, and
  memberships[] (`department_id`, state, `effective_at`, optional
  `revoked_at`). Hub emits `EmployeeMembershipChanged` with the same complete
  membership snapshot, new `membership_version`, effective time, actor, reason,
  and correlation id; omission from an older snapshot never implies
  revocation. `EmployeeDeactivated` carries employee id, effective time,
  reason, and final membership version and also kills Telegram pairing and
  integration credentials.
- QT `crew_members` additionally holds the pay-side fields (QT truth):
  `base_rate_cents`, `in_p4p_pool`, `pay_mode` (`hourly`|`shadow`|`p4p`),
  `language`. `hub_employee_id` is nullable until Hub Phase 0 lands, then
  backfilled; partial provisioning is labeled and retried, never a silent
  duplicate.
- Departments are memberships and eligibility facts, not authorization
  grants. Non-sensitive navigation may reflect the union of an employee's
  memberships; multiple memberships never union sensitive permissions.
- For an open paid-day envelope, the server maintains a non-overlapping
  timeline of department-context intervals with exactly one active context at
  each effective instant. Clock In opens the first interval. An accepted
  context switch atomically closes the current interval and opens the next; it
  never retroactively reclassifies an earlier interval.
- Every department-scoped request is denied unless the server verifies: an
  active linked employee; a current membership and matching
  `membership_version`; the required explicit capability; the active
  department context when the action belongs to paid work; and assignment or
  resource scope. A role or membership string alone never authorizes a read or
  mutation.
- QT stores only the latest acknowledged Hub membership snapshot. A command's
  `membership_version` must exactly match it. Missing, stale, out-of-order, or
  deactivated membership state fails closed and enters reconciliation; it
  invalidates affected signed offline packets and cached grants.
- Owner/Admin capabilities are provisioned only to Naldo and Jason in V1 and
  their sensitive reads are access-logged. Manager capabilities remain
  unprovisioned; every Manager claim is denied in V1.
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
  and job action affordances only for a current Installer context,
  `membership_version`, explicit installer capability, and assigned resource
  scope. Enforced server-side on every request; cached screens cannot bypass.
  The audited owner emergency override and signed offline work packet
  ("Clock-in waiting to sync") are the only crew-gate exceptions.
- Exact address, customer contact, route, design/load-list, private note, and
  job-action fields are filtered server-side from the authenticated actor; an
  `assigned_to` query parameter is a filter, never authorization.
- Office and Owner/Admin work does not bypass the crew gate through a role or
  secondary membership. It uses separate capability-gated office/admin
  operations. Office access requires an accepted Clock In, current Office
  context, explicit `office_job_operations` capability, and resource scope.
  Owner/Admin access is limited to Naldo and Jason and is audited. A
  multi-department employee switches context before performing work for a
  different department.
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

- `jobs/{id}/complete` stores a NON-financial state using the contract-defined
  values `field_work_completed` or
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
- **Display law (binding):** provisional renders EXACTLY as
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
- Advertising `paid_seconds` are the approved union of paid-day intervals whose
  active department context is Advertising, excluding unpaid breaks. They
  include authorized allocation pickup, loading, travel between placements,
  placement work, offline recovery, and return reconciliation. Placement Run
  duration is a productivity metric and never substitutes for paid seconds.
- Hub reports pay inputs weekly through the `AdvertisingWeekClosed` event in
  P11. The QT computes pay only from the accepted-and-acknowledged net pay
  count. Inventory reports `signs_issued`, accepted sign placements,
  `expected_back = signs_issued + signs_transferred_in -
  signs_transferred_out - accepted_sign_placements`, returned signs, approved
  damage/loss observations, transfers, and variance as distinct fields.
  Inventory reconciliation informs restock and review and never changes or
  deducts wages (NY §193 applies to the ad crew too).
- Sign inventory ledger is Hub-owned (advertising domain): stock on hand,
  weekly issuance per person, placement decrements, week-end reconciliation.
- Piece-rate pay basis requires its own written comp terms and WTPA notice,
  same as the installers' P4P (attorney reviews both in one pass).
- Digest model (Naldo's ruling): FOUR per-department digests (office,
  advertising, install, management), each combining that department's ops
  and attendance; admins receive all four. The QT morning ops digest and the
  hub coaching digest fold into this model; digest content APIs follow the
  same provisional-pay display law.

## 8c. Flow H: commitment verification events (QT -> commitment store), v1.4.0-draft

> Proposed by the Quote Tool side 2026-08-07 under the §10 change process, for
> ledger #217 (post-call commitment engine). MINOR bump: new endpoints, no
> changed semantics on any existing flow. Codex is the named reviewer for the
> consumer side; a human merges. No money movement and no ownership change, so
> no DECISIONS.md line is required.

**Purpose.** The copilot extracts typed COMMITMENTS from call transcripts ("send
the quote today", "call back at 3"). Those items are only worth having if they
CLOSE on evidence rather than on a rep remembering to tick a box — the standing
caution from our own data is that two machine-generated queues already exist and
die unworked (`second_mile_touches`, 108 rows, 0 ever completed). The Quote Tool
holds the ground truth for closure: it sends the quotes and mirrors outbound SMS,
and the copilot logs every call attempt. Flow H is the feed that carries that
evidence.

**Direction and ownership.** QT is the sole producer. QT owns the event
definitions and the `/api/ops/v1/commitment-events` route, consistent with §0
(the Quote Tool assistant is the single author of `/api/ops/v1`). The consumer is
the commitment store; the hub renders a board over it and never writes
verification events.

**Store location (resolved 2026-08-07).** `call_commitments` lives in the copilot
DB, alongside the transcripts and the LLM passes that produce it. This was
blocked while the copilot's anon key held full read/write on 26 tables of
transcript PII (ledger #221, Supabase advisor CRITICAL). #221 shipped
2026-08-07 — RLS enabled on every public table, verified at the
`pg_class`/`pg_roles`/`pg_policies` level, plus a follow-up revoking the
redundant anon/authenticated GRANTs and the default privileges that would have
re-granted them on future tables — so the blocker is retired and the natural
home wins.

### Events

Three event types. Each carries the full section 1.3 envelope, including
`idempotency_key`, `source`, `entity_version`, `correlation_id`, `causation_id`,
`accepted_at`, and all three version fields. A bare contact-keyed stream is
explicitly NOT the shape.

| Event | Emitted when | Carries |
|---|---|---|
| `QuoteSent` | `quotes.quote_sent_at` transitions null -> non-null | quote id, quote_number, contact identity, sending rep identity, sent-at, total in integer cents |
| `OutboundMessageSent` | an outbound SMS or email to a contact is mirrored | outbound delivery id, contact identity, performing identity, channel, sent-at, `has_media`, `has_portal_link` |
| `CallAttempted` | a call attempt is logged | call attempt id, contact identity, performing identity, direction, duration seconds, `connected`, attempted-at |

`OutboundMessageSent` deliberately carries BOOLEAN content signals, never the
message body. `contact_identity.resolution=resolved` carries an opaque internal
`contact_ref`, never a phone number or email address. When QT cannot resolve a
safe identifier, `resolution=manual_only` and `contact_ref=null`; the event is
still delivered but cannot auto-clear a commitment. The clearing rules need to
know whether an outbound contained media or a portal link; that is answerable
without shipping customer message text across a service boundary. This
metadata remains customer-linked operational data. Before Flow H is enabled,
its implementation PR must pin the
permitted reader roles, retention/deletion period, and audit/export behavior;
the independent kill switch remains off until those rules are approved.

`performed_by.kind=employee` requires the employee UUID and is used whenever a
human caused the action, including when a system worker emitted the event on
that employee's behalf. `kind=system` requires a non-empty autonomous principal
name and is reserved for actions with no human performer. It is never valid to
drop a known employee merely because the event source is `system`.
For an employee performer, `performed_by.employee_id` equals the envelope's
`actor_employee_id`, including when `source=system`. For an autonomous system
performer, the envelope's `actor_employee_id` is `null`. Producer tests enforce
these sibling-field relationships because portable JSON Schema cannot compare
their values.

Aggregate identity is fixed per event type. For `QuoteSent`, `aggregate_id` is
the canonical string form of `quote_id` and `entity_version` is the committed
quote-row version after the send transition. For `OutboundMessageSent`,
`aggregate_id` is `outbound_delivery_id`; for `CallAttempted`, it is
`call_attempt_id`. Those two immutable evidence records start at
`entity_version=1`; a correction increments the same record's version rather
than minting a second aggregate. Producer tests enforce field equality because
portable JSON Schema cannot compare the values of two sibling fields.

### Transport

- Transactional outbox on QT, inbox dedup on the reader (§1). Same
  `idempotency_key` + same payload returns the original result; same key with a
  different payload is rejected as `conflict_idempotency`.
- PULL, not push, for v1:
  `GET /api/ops/v1/commitment-events?since=<cursor>&limit=<n>`, cursor-paginated
  per §1's pagination rule. `limit` is 1 through 500 and defaults to 100. A
  request includes all three signed version headers from §1.4. A
  page with `has_more=true` always carries a non-empty `next_cursor`; a terminal
  page may carry either its next polling checkpoint or `null`. A pull feed does
  not lose evidence merely because the consumer is temporarily unavailable.
  Before enablement, the implementation PR pins cursor retention and expiry. An
  expired cursor returns HTTP 410 with the typed, versioned
  `cursor_expired` error and forces an audited admin reconciliation; it never
  silently resumes from a newer cursor.
- **Authentication is stated explicitly here because the §1 envelope does NOT
  provide it.** Idempotency keys and outbox/inbox dedup solve duplicate delivery;
  they authenticate nothing. Flow H uses the §1 environment-scoped machine
  credential for the consumer->QT direction because the consumer sends this
  HTTP request and QT receives it, with signed timestamp + nonce replay
  protection. A future QT-initiated push would use a distinct QT->consumer
  credential. (An S54 review of the #217 plan caught that plan citing the
  envelope as if it covered auth. It does not.)
- Kill switch `COMMITMENT_EVENTS_ENABLED`, independent per §1. Switched off the
  endpoint returns HTTP 503 with the typed, versioned `kill_switched` error —
  never a silent empty page, which is
  indistinguishable from "nothing happened" and would stall every open commitment
  into expiry while looking healthy.
- The route enters `operatorGate`'s allowlist in the SAME PR that builds it,
  verified on a signed-out request (§1 and the AGENTS.md pitfall: with the gate
  on, a missing path is default-denied BEFORE the route runs, and it hides in
  every test where you are signed in).

### Clearing rules the feed must support

Binding, from the #217 plan's own acceptance criteria:

- A clearing event closes the OLDEST open commitment of that kind for the
  contact, NEVER every open item of that kind. One contact can hold two open
  `send_quote` promises from two different calls; closing both on one send marks
  a promise kept that never was.
- Auto-verify is OFF (manual check-off only) for any commitment whose contact
  fails clean identity resolution. Such items are flagged manual-only at creation
  and routed to a no-match review lane — never left to age into expiry looking
  ignored, which is the false-OPEN mirror of a false-clear.
- A clear by a DIFFERENT rep than the promising rep closes the item VISIBLY
  ("done by <rep>"), never silently. An autonomous action is shown as
  "done by automation (<principal>)" rather than being attributed to a person.

### Open dependency: customer identity

§2's Flow I maps STAFF only (`employee_id` <-> `crew_members.id` <-> phone <->
`telegram_user_id`). There is no canonical CUSTOMER identity mapping, and
`quotes.highlevel_contact_id` is nullable with a demonstrated ~99% null rate on
one backfill class (166 of 168). Flow H therefore models identity resolution
explicitly. QT may emit a resolved opaque identifier only after its own trusted
mapping succeeds; otherwise it emits `manual_only` with a null reference. Phone
digits and email addresses never cross this service boundary. Any local
digits-suffix fallback matcher may help a human review the event inside its
source system, but it cannot convert the event to auto-clearable without a
trusted opaque mapping. The no-match review lane is #217's own work.

Separately, the copilot's `rep_email` / `ghl_user_id` do NOT appear in Flow I's
mapping at all. Attributing a commitment to a hub `employee_id` requires adding
that link to Flow I (additive, a patch bump) before any per-employee board can
key its lanes. Named here so it is not rediscovered mid-build. Inbound calls
additionally carry no attribution at all until ledger #219 lands
(`call_recordings.ghl_user_id` is NULL on every inbound call), which is why the
plan routes unattributed inbound to a shared unclaimed lane in the interim.

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

## 9b. v1.3.0 canonical amendments

P1-P15 below are the complete normative amendments. P16 configuration status
is recorded in this file. Historical proposal and decision files are not
required to implement this contract. Where this section and earlier flows
differ, this section wins; semantics merge and never weaken.

- **P1 versions:** every request, response, event, and health surface carries
  `contract_version`, `schema_version`, and `client_version`. Deploys fail on
  contract/schema incompatibility; CI byte-compares canonical and mirror.
- **P2 envelope:** the complete request, response, status, review, and error
  shapes are in sections 1.1 and 1.2. Every consequential mutation uses them.
  `GET /api/ops/v1/commands/{command_id}` resolves post-timeout state.
- **P3 identity:** admin-seeded `crew_members` may start Track A; QT never
  creates or mutates Hub employees. Owner-only
  `POST /api/ops/v1/identity-links` carries:

  ```text
  quote_crew_member_id
  hub_employee_id
  verified_phone_e164
  telegram_user_id | null
  reason
  effective_at_requested
  expected_entity_version
  ```

  `IdentityLinked`, `IdentityLinkChanged`, and `IdentityUnlinked` each carry
  `quote_crew_member_id`, `hub_employee_id`, `phone_e164`, optional
  `telegram_user_id`, `prior_link_version`, `entity_version`, `effective_at`,
  `actor_employee_id`, reason, and correlation id. Duplicate phone, Telegram,
  or employee links hard-fail into an owner review queue.
- **P4 departments:** section 2's interval and authorization rules apply.
  Clock In requires `active_department_id` plus `membership_version`.
  `POST /api/ops/v1/me/department-context/switch` atomically changes the
  current interval and emits `DepartmentContextChanged`. A switch during an
  open break, segment, or Placement Run rejects with review until P16.2 is
  ruled. No retroactive reclassification.
- **P5 offline packets:** signed scoped
  `POST /api/ops/v1/me/offline-packets` returns a packet containing:

  ```text
  employee_id
  business_date
  allowed_operations[]
  allowed_entity_ids[]
  issued_at
  expires_at
  contract_version
  schema_version
  membership_version
  device_id
  job_snapshot_versions[]
  nonce
  ```

  Drift, GPS-age, and sequence limits are P16.1 launch configuration. Missing
  GPS review-flags a command and never erases it or fabricates evidence. The
  server persists device time, receipt time, requested effective time, chosen
  effective time, and the policy/reviewer that selected it.

  A packet may authorize an encrypted sensitive job snapshot only after an
  accepted Clock In and current Installer context, membership version,
  capability, assignment scope, and registered device all validate. The
  snapshot manifest carries job/design/load-list entity versions, generation
  time, expiry, and purge deadline. The Hub binds it to a non-exportable device
  key and purges it on expiry, logout, account change, accepted department
  switch, deactivation/revocation receipt, or the next app open after any of
  those states. Until P16.1 sets and tests packet lifetime, device binding,
  encryption, and purge behavior, offline sensitive-detail rendering is
  disabled; non-sensitive summaries and advertising capture remain available.
- **P6 time:** semantic operations are `clock_in`, `break_start`, `break_end`,
  `arrive_job`, `depart_job`, `travel_start`, `travel_end`,
  `non_billable_start`, `non_billable_end`, and `clock_out`. Unsegmented paid
  day time returns as `unclassified_seconds`; the Hub never infers travel.
  Travel remains paid day time inside the envelope, and explicit operations or
  an approved classification rule assign it. The unclassified residual
  surfaces missed taps; it does not unpay time.

  ```text
  time_exception_type =
    forgotten_clock_out | open_break | open_segment | missed_tap | overlap |
    duplicate | device_clock_drift | gps_missing | gps_poor_accuracy |
    overnight_or_dst | active_department_mismatch | offline_packet_issue |
    correction_request

  correction_target_type =
    day | break | segment | classification | department | effective_time
  ```

  `POST /api/ops/v1/me/time-correction-requests` carries `target_type`,
  `target_id`, optional `requested_effective_at`, `requested_value`, reason,
  and `evidence_refs[]`. Employee-scoped
  `GET /api/ops/v1/me/time-correction-requests` and
  `GET /api/ops/v1/me/time-correction-requests/{id}` return request id, target,
  submitted values/time, state (`submitted` | `under_review` | `accepted` |
  `partially_accepted` | `rejected` | `adjusted_forward`), safe resolution
  reason, chosen effective time, resulting entity version, and any forward
  adjustment reference. `TimeCorrectionRequested` and
  `TimeCorrectionResolved` events carry the same employee-safe state. Owner-only
  `POST /api/ops/v1/time-correction-requests/{id}/resolve` carries decision
  (`accepted` | `partially_accepted` | `rejected`), chosen effective time,
  before, after, reason, actor, and entity version. Locked periods adjust
  forward only. Six-year retention in section 5 stands.
- **P7 job facts:** assignment reads add `budgeted_elapsed_hours`,
  `planned_crew_size`, `budgeted_crew_hours`, `job_lead_employee_id`,
  `assigned_crew[]` with roles, design/load-list refs, notes, gate state, and
  source version. Pre-clock responses omit sensitive fields and action tokens.
  An audited emergency override carries `requester_employee_id`,
  `approver_employee_id`, `affected_employee_id`, reason, `starts_at`,
  `expires_at`, and `correlation_id`.
- **P8 completion:** two independent dimensions:
  `field_work_state` (`not_started` | `in_progress` |
  `field_work_completed`) and `completion_review_state` (`not_submitted` |
  `completion_submitted_for_office_review` | `accepted` | `needs_changes`).
  `depart_behavior` is `depart_at_completion` (atomically close the actor's
  open job segment and submit completion) or `keep_segment_open` (submit and
  return an explicit open-segment warning). Pinned material fields remain.
  Offline drafts use a checksum media manifest and durable-before-submit.
  Events are `FieldWorkCompleted`, `CompletionReviewChanged`, and
  `JobDeparted`; none is financial completion.
- **P9 quality and deactivation:** an employee-readable quality case carries:

  ```text
  quality_case_id
  job_id
  state
  quality_window_closes_at
  evidence_refs[]
  reason_code
  responsibility_scope
  employee_response_state
  employee_response_deadline
  reviewer_employee_id | null
  final_event_version
  ```

  `GET /api/ops/v1/crew/{id}/deactivation-readiness` lists `open_clocks[]`,
  `open_corrections[]`, `unclosed_pay_weeks[]`,
  `provisional_quality_cases[]`, `pending_payroll_adjustments[]`,
  `unacknowledged_placement_events[]`, `inventory_allocations[]`,
  `dead_letter_commands[]`, and `identity_links[]`. Retained final-pay and
  audit records are never deleted.
- **P10 placement events:** event types are `PlacementAccepted`,
  `PlacementReversed`, and `PlacementAcceptanceCorrected`. Every event carries
  the full section 1.3 envelope plus:

  ```text
  placement_id
  employee_id
  identity_link_version
  membership_version_at_capture
  paid_day_envelope_id
  advertising_context_interval_id
  campaign_id
  unit_type
  business_date
  captured_at
  hub_received_at
  reviewer_employee_id | null
  reason_code | null
  inventory_event_id | null
  ```

  The envelope uses `aggregate_id = placement_id` and its `entity_version` is
  the placement entity version.

  `PlacementReversed` carries `reverses_event_id` referencing the original
  accepted event. `PlacementAcceptanceCorrected` carries `corrects_event_id`,
  `prior_values`, and `corrected_values`.
  `POST /api/ops/v1/advertising/placement-events/batch` returns per event:
  `event_id`, status (`accepted` | `duplicate` | `rejected` |
  `needs_review`), optional `canonical_operation_id`, optional
  `duplicate_of_event_id`, optional error code, optional entity version,
  optional `earning_business_date`, optional `compensation_config_version`,
  and optional `piece_rate_cents_snapshot`. QT dedupes by event id.

  QT acknowledges a placement as payable only after the linked paid-day
  envelope and Advertising context interval cover `effective_at`, the employee
  and membership version match, the unit is pay-enabled, and the acceptance is
  otherwise valid. A Hub-accepted placement missing that linkage remains
  `needs_review`, cannot enter `net_pay_count`, and blocks week close rather
  than disappearing. On payable acknowledgment, QT derives the earning
  business date and persists the effective compensation-config version and
  piece-rate-cents snapshot. The Hub never supplies or computes the rate.
  Reversal/correction applies an append-only delta against the original
  snapshot; it never reprices the original event at today's rate. A correction
  that validly changes the earning date records both old and new snapshots.
  `GET /api/ops/v1/advertising/placement-reconciliation` groups by
  `employee_id`, `campaign_id`, `week_start`, `week_end`, and `unit_type` and
  returns Hub/QT accepted and reversed counts, difference, and
  `source_through`.
- **P11 advertising weeks:** states are `open` ->
  `submitted_for_reconciliation` -> `ready_to_close` -> `closed` ->
  `adjusted`. Close blocks on `placement_events_unacknowledged`,
  `identity_link_unresolved`, or `inventory_reconciliation_incomplete`.
  `AdvertisingWeekClosed` carries the full section 1.3 envelope plus:

  ```text
  employee_id
  week_start
  week_end
  timezone
  closed_by_employee_id
  closed_at
  approved_by_employee_id
  approved_at
  accepted_count
  reversed_count
  net_pay_count
  campaign_unit_breakdown[]
  signs_issued
  signs_transferred_in
  signs_transferred_out
  signs_placed
  signs_returned
  approved_damage_or_loss
  expected_back
  actual_back
  variance
  source_event_high_water_marks[]
  reconciliation_status
  ```

  The envelope `aggregate_id` is the advertising-week id and its
  `entity_version` is the advertising-week entity version.

  Each campaign/unit item carries `campaign_id`, `unit_type`, accepted count,
  reversed count, and net pay count. Those aggregate counts are reconciliation
  claims, not authoritative rates or pay. QT rebuilds the payable count from
  acknowledged event-level snapshots and blocks close on any mismatch.
  Compensation config effective-dates the rates; initial values are **250 cents
  per accepted sign placement** and a **1700 cents/hour floor**. QT returns
  `rate_config_breakdown[]` (earning date/range, compensation-config version,
  piece rate cents, net pay count, unit pay cents), aggregate `net_pay_count`,
  `unit_pay_cents`, `floor_rate_cents_per_hour`, `paid_seconds`,
  `floor_required_pay_cents`, `floor_true_up_cents`, `total_pay_cents`, state,
  and blockers. Only acknowledged accepted sign placements enter pay.
  Inventory variance is never a wage deduction. Door-hanger pay stays
  unconfigured.

  For one employee and America/New_York workweek, using the rate versions
  effective on each work date:

  ```text
  unit_pay_cents =
    sum(event_net_count x event_piece_rate_cents_snapshot)
  floor_required_pay_cents =
    ceil(sum(paid_seconds x effective_floor_rate_cents_per_hour) / 3600)
  floor_true_up_cents = max(0, floor_required_pay_cents - unit_pay_cents)
  total_pay_cents = unit_pay_cents + floor_true_up_cents
  ```

  All inputs and outputs are integers. The ceiling occurs once after summing
  the effective-rate segments for the week so the floor is never rounded down.
  Reversals or corrections after a closed/locked/exported period create a
  forward adjustment that references the original event and rate snapshot;
  they never mutate or reprice the exported period.
  Overtime and blended-rate treatment remains disabled until P16 configuration
  is approved; this formula does not authorize a pay flip before that gate.
- **P12 office metrics:** qualified-call formula is versioned and
  effective-dated. Stat reads expose numerator, denominator, exclusions,
  source-through time, and formula version. Seller attribution uses immutable
  identity and an owner correction flow, never name matching.
- **P13 digests:** types are `office`, `advertising`, `install`, and
  `management`. A canonical facts endpoint or event bundle per type/period
  carries source-through time and versions. Hub composes and delivers.
  Persisted digest records carry input versions, recipients, artifact
  checksum, and delivery state. Naldo and Jason receive all four. The display
  law applies; scheduled delivery has a separate deadline/retry policy from
  the two-second command SLA.
- **P14 payroll:** QT owns:

  ```text
  GET  /api/ops/v1/payroll/periods/{id}/readiness
  POST /api/ops/v1/payroll/periods/{id}/close
  POST /api/ops/v1/payroll/periods/{id}/exports
  GET  /api/ops/v1/payroll/periods/{id}/adjustments
  ```

  Blocking reason codes are `unapproved_time`, `open_clock`, `open_break`,
  `open_job_segment`, `unresolved_quality_state`,
  `placement_acknowledgment_mismatch`, `advertising_week_mismatch`,
  `identity_issue`, `compensation_config_missing`, and `pending_adjustment`.
  A blocker record carries code, employee id, affected entity id, detected
  time, safe description, and resolution state. Only Naldo or Jason may close
  or override with an audited reason.

  CSV carries no provisional value. Each pay-line row has a stable
  `pay_line_id`. Valid pay line types are `hourly_base`,
  `installer_performance_earned`, `advertising_piece_rate`, `floor_true_up`,
  `training_bonus`, `referral_bonus`, `manual_adjustment`, and
  `employee_subtotal`. The required per-employee subtotal row uses
  `line_type = employee_subtotal`, a stable id
  `subtotal:{employee_id}:{period_start}:{period_end}`, blank
  quantity/unit/rate/reference fields, and `amount_cents` equal to that
  employee's included pay-line sum. Vendor mapping and overtime/blended-rate
  treatment remain owner/payroll decisions; QuickBooks is out of V1.
- **P15 observability:** every event has stable event id, aggregate/entity
  version, occurred/effective time, contract/schema version, actor/source, and
  correlation id. Outbox delivery is at-least-once with idempotent consumers.
  DLQ metrics include depth, oldest age, operation, and last error and alert
  through the QT bot. Reconciliation runs for every event family. Replay never
  duplicates business effects.

### v1.3.0 configuration rulings (Naldo, 2026-08-07; P16 items 5, 6, 8, 10)

- **Door hangers (P16.5): pay OFF.** No door-hanger pay unit is configured;
  door-hanger placements never enter a pay count or an
  `AdvertisingWeekClosed` net count until a later ruling. The protective
  residential-privacy default lets the capturing employee see exact evidence
  only while the placement is local, pending, under review, or inside its
  correction window. After verification, exact address, coordinates, and
  photos are Naldo/Jason-only; employee maps aggregate/round them. Exact
  residential evidence never appears on internal-public maps, leaderboards, or
  digests. Any door-hanger pay field stays null, and the engine treats a
  configured-null unit as "feature disabled", never as zero-value work.
- **Completion media (P16.6): NOT REQUIRED, three prompts.** The completion
  command never blocks on `photo_refs[]`. The surface prompts at most three
  times, then completes without media. The same three-attempt cadence is the
  default for missed-tap nudges. Marked provisional by the owner.
- **Digests (P16.8):** all four types send at **08:00 America/New_York,
  daily**. Per-department recipients plus Naldo and Jason on all four.
  Delivery failures retry per P13/P15 and surface in the admin queue;
  escalation policy remains open.
- **Payroll CSV (P16.10): generic vendor-neutral format for now.** One row
  per pay line, UTF-8, header row, no provisional values:
  `pay_line_id, employee_id, employee_name, period_start, period_end,
  line_type, description, job_or_campaign_ref, quantity, unit, rate_cents,
  amount_cents, state, notes`, with the P14 per-employee subtotal row.
  `line_type` enum:
  `hourly_base`, `installer_performance_earned`, `advertising_piece_rate`,
  `floor_true_up`, `training_bonus`, `referral_bonus`, `manual_adjustment`,
  `employee_subtotal`.
  Vendor column mapping and OT/blended-rate treatment stay open for the
  payroll professional; QuickBooks remains out of V1.

### v1.3.0 unresolved launch configuration

These values are intentionally absent and disable only their named behavior:

1. Offline-packet lifetime, device-clock drift, GPS age/accuracy, and allowed
   operations.
2. Department switching during an open Placement Run, job segment, or break,
   plus approval rights. Safe default: reject with review.
3. Installer travel-classification and missed-tap thresholds.
4. Placement rejection/reversal reason codes, reviewer SLA, and advertising
   week-close roles.
5. Qualified-call formula and seller-credit correction policy.
6. Digest escalation after configured retries.
7. Deactivated-employee self-service duration.
8. Payroll overtime and blended-rate treatment.

An unresolved configuration disables only its affected behavior. Clients must
not infer a value, silently choose a default, or weaken a safety gate.

**Shared schema artifact path (Phase 0):**
`yll-quote-tool/docs/context/ops-contract-schema/` (generated from the
OpenAPI fragments; the manifest starts at independent
`schema_version = 1.0.0-draft`; both CIs validate against it and the Hub vendors
the same files byte-identically).

## 10. Change process

1. PR against this file (and the mirror in the same or a paired PR) BEFORE
   or WITH the implementation.
2. Both assistants named reviewers; a human merges.
3. Money movement, ownership changes, or display-law changes need Naldo's
   explicit approval recorded in both paired PRs.
4. Version bumps: patch for additive fields, minor for new endpoints, major
   for semantics. Both repos must reference the identical version before
   either builds against a change.
