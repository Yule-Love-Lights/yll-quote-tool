# Jobber-flow Implementation Plan

> **For agentic workers:** This is a **phased blueprint** for a multi-subsystem epic (ledger #83). It is gated on **#81 (auth perimeter)** and needs **Jason coordination** (most of it is his area + the SHARED data layer). When a phase is greenlit to build, generate that phase's **granular task-by-task TDD plan** with superpowers:writing-plans (one plan per phase → `docs/jobber-flow/plans/<phase>.md`), then execute with superpowers:subagent-driven-development. Don't build ahead of #81.

**Goal:** Make the YLL quote tool mimic Jobber's Quote → Job → Invoice pipeline (with statuses, e-sign, auto-created jobs/invoices, and a Valor-collected 50% balance) so YLL can retire Jobber for operations.

**Architecture:** Extend the existing single-`quotes`-row, timestamp-driven lifecycle with **explicit statuses** and two new linked objects — **`jobs`** (auto-created at deposit-paid) and **`invoices`** (auto-created at install-complete, deposit applied → 50% balance charged via the stored Valor vault token, fallback portal pay-link). A stable **`customers` + `properties`** identity enables "rebook last season." A Jobber-style **Workflow board** on the dashboard visualizes the pipeline. Reuse the proven Valor hosted-page + idempotent-webhook patterns and HighLevel messaging.

**Tech stack:** Next.js 16 (App Router), TypeScript, Supabase (Postgres + Storage), Vitest, Konva (design, unchanged), Valor (payments), GoHighLevel (CRM/messaging). Spec: `docs/jobber-flow/SPEC.md`.

---

## Prerequisites & cross-cutting

- **P0 — #81 auth perimeter is BLOCKING.** Every surface below (jobs, invoices, card charges, amend-order, customer/property pages) exposes operator data or moves money and MUST sit behind the server-side operator auth from #81. Do not ship any phase here onto the current open operator surface. (#81 is tracked separately; it's the next-session top priority in Jason's area.)
- **Area ownership / coordination.** The **Workflow board** is Naldo's dashboard area (#58). The **Quotes/Jobs/Invoices engine, portal changes, Valor balance, and amend-order** are **Jason's area + the SHARED data layer** (`src/lib/quotes.ts`, new tables, `sceneTypes`/shared types). → Coordinate with Jason before building; PR-not-master; gates (`npx tsc --noEmit` · `npm run lint` · `npm test`) green; a human approves each merge.
- **Migrations.** Follow the repo pattern: a dated `migrations/2026-xx-xx-*.sql`, additive + idempotent, applied to the live Supabase before the dependent code merges (prod auto-deploys `master`; a missing column errors the whole query). Apply via the Chrome-extension + SQL editor (or `gh`/SUPABASE_DB_URL where available), then merge.
- **Testing strategy.** Pure logic (status transitions, balance math, display-ID allocation, projection) → Vitest unit tests (the engine/portal already have ~360 tests to extend). API routes → route tests mocking Supabase + Valor + HighLevel (mirror `src/app/api/integrations/valor/webhook/route.test.ts`). Konva/portal visuals can't be headless-screenshotted → verify via preview DOM + a human on-device, as established.
- **Reuse, don't reinvent:** `valor_vault_token` (already stored at deposit) for the balance charge; `src/lib/integrations/valor.ts` hosted-page + HMAC webhook patterns; `src/lib/quoteMessages.ts` + HighLevel for receipts/notices; `src/lib/portal/derivePackages.ts` `priceSelection` for server-side re-pricing.

## Data model (target state across phases)

> **Resolves SPEC §9 open item — recommendation: dedicated `jobs` and `invoices` tables** (not fields-on-`quotes`). Cleaner status independence, a clean From-Quote FK, and room for the job/invoice lifecycle without overloading the quote row.

- **`quotes`** (existing) gains: `status` (text, see enum below), `decline_reason` (text null), `quote_number` (int, unique seq); signature stored inside `approval_snapshot` jsonb (`{name, kind:'typed'|'drawn', value, signed_at, ip}`). Amendment trail in `approval_snapshot.amendments[]`.
- **`jobs`** (new): `id` uuid pk, `quote_id` fk, `customer_id` fk, `property_id` fk, `job_number` int unique seq, `type` (`one_off`|`permanent`), `status` (see enum), `line_items` jsonb (snapshot at creation), `install_date` date null (synced from home.works later), `completed_at` timestamptz null, `created_at`. **🔗 SHARED with the Inventory epic #82** — that epic adds operational Stages-Kanban fields to the SAME `jobs` table (both auto-create the row on the deposit-paid #38 webhook). Build ONE `jobs` object, coordinated with Jason.
- **`invoices`** (new): `id` uuid pk, `job_id` fk, `quote_id` fk, `customer_id` fk, `invoice_number` int unique seq, `subtotal`/`discount`/`tax`/`total` numeric, `deposit_applied` numeric, `balance` numeric, `status` (see enum), `tax_overridden` bool default false, `valor_balance_txn_id`/`valor_receipt_url` text null, `created_at`, `paid_at` null.
- **`customers`** + **`properties`** (new, P5): stable identity (today loose-matched by HL contact→email→phone→name). `customers(id, hl_contact_id, name, email, phone, created_at)`; `properties(id, customer_id, address, lat, lng, created_at)`. Quotes/jobs/invoices reference both.
- **Sequential display numbers:** Postgres sequences seeded at the chosen start (recommend 1000) — `quote_number_seq`, `job_number_seq`, `invoice_number_seq`. Allocated on row insert. **UUID stays the pk + portal token** (display numbers never appear in a URL — see SPEC §4.6).

**Status enums**
- Quote: `draft · sent · viewed · approved · booked · changes_requested · declined · cancelled · lost`
- Job: `to_schedule · scheduled · installed · complete · requires_invoicing · done · cancelled`
- Invoice: `draft · awaiting_payment · paid · cancelled`

## File structure (created/modified across phases)

- **Lib (new):** `src/lib/quoteStatus.ts` (status enum + legal transitions, pure) · `src/lib/displayId.ts` (sequence allocation) · `src/lib/jobs.ts` · `src/lib/invoices.ts` · `src/lib/customers.ts` · `src/lib/integrations/valorBalance.ts` (vault-token charge, wraps `valor.ts`).
- **Lib (modify):** `src/lib/quotes.ts` (status column + selects) · `src/lib/portal/{loader,adapter,derivePackages}.ts` (decline/changes/signature/amend re-price) · `src/lib/quoteMessages.ts` (decline/changes/balance/receipt templates) · `src/lib/dashboard/*` (board data).
- **API (new):** `src/app/api/quotes/[id]/decline/route.ts` · `request-changes/route.ts` · `src/app/api/jobs/[id]/complete/route.ts` · `src/app/api/jobs/route.ts` (list) · `src/app/api/invoices/[id]/pay-balance/route.ts` · `src/app/api/integrations/valor/balance-webhook/route.ts` · `src/app/api/quotes/[id]/amend/route.ts`.
- **API (modify):** `src/app/api/quotes/[id]/approve/route.ts` (capture signature; server-recompute) · `src/app/api/integrations/valor/webhook/route.ts` (on deposit-paid → auto-create Job).
- **Portal (modify/new):** decline + request-changes controls + signature capture in the approve flow (`src/components/portal/*`, `snowglobe/StickyBottomBar.tsx`) · `src/app/portal/[quoteId]/pay-balance/page.tsx`.
- **Operator/dashboard (new):** `src/components/dashboard/WorkflowBoard.tsx` (Naldo) · admin jobs/invoices list + detail (`src/app/admin/jobs/*`, `src/app/admin/invoices/*`) · amend-order UI in the builder/admin.
- **Migrations:** one per phase under `migrations/`.

---

## Phase 1 — Status spine + decline/request-changes + e-signature

**Objective:** Replace the implicit timestamp-derived state with an explicit status, and add the portal Decline-with-reason / Request-changes loop + signature capture on approval. No jobs/invoices yet.
**Depends on:** P0 (#81). Independent of the home.works TBD.

**Data model:** migration adds `quotes.status`, `quotes.decline_reason`, `quotes.quote_number` (+ `quote_number_seq` seeded). Backfill `status` from existing timestamps (deposit_paid→booked, approved→approved, sent→sent, else draft).

**Tasks:**
1. `src/lib/quoteStatus.ts` — `QuoteStatus` union + `deriveStatus(row)` (from timestamps, for backfill + read fallback) + `canTransition(from,to)` table. Pure. **Tests:** transition legality + derive-from-timestamps cases.
2. `src/lib/displayId.ts` — `allocateNumber(seq)` via the Postgres sequence. **Tests:** monotonic allocation (mocked).
3. Migration `migrations/2026-xx-quote-status.sql` — add columns + sequence + backfill. Apply to live Supabase first.
4. `src/lib/quotes.ts` — add `status`/`decline_reason`/`quote_number` to selects + writers; set `status` on send/approve/booked; assign `quote_number` on first save.
5. Approve route — capture `signature` into `approval_snapshot`; set `status='approved'` then `booked` on deposit webhook. (Also fold in the audit's MEDIUM: server-recompute total — but coordinate, that's an existing finding.)
6. New routes `decline` + `request-changes` — validate body (reason/note required, length-capped, **behind admin/portal auth as appropriate**), stamp status + `decline_reason`, optional HighLevel note, fire staff email via `quoteMessages.ts`. **Tests:** route tests (valid, missing reason, wrong status).
7. Portal UI — Decline (reason modal) + Request-changes (note modal) actions on `StickyBottomBar`; signature capture (typed or drawn `<canvas>`) in the approve step, sent in the approve POST. Admin shows status badges + decline reason.
8. Status badges across `/admin/quotes` + dashboard worklist.

**Done when:** a quote moves draft→sent→viewed→approved(+signature)→booked with explicit status; a customer can decline (reason) or request changes (note → staff edit → resend); gates green; verified on a preview quote.

## Phase 2 — Jobs (auto-created) + the Workflow board

**Objective:** Auto-create a Job when a quote is booked; show the Quotes·Jobs·Invoices Workflow board on the dashboard.
**Depends on:** P1. **🔗 Shared job entity:** the `jobs` object is SHARED with the Inventory epic #82 — both auto-create a job on the **deposit-paid (#38) webhook** (Jason confirmed Job ID ≠ Quote ID). Build ONE `jobs` table: inventory adds operational/Stages-Kanban fields, this adds billing statuses + the invoice link. **Coordinate with Jason before creating it.** **Blocked-by-decision:** SPEC §2 "where Jobs live" TBD — this plan assumes **Jobs are created in our tool** (recommended); confirm before building. Scheduling is out (home.works, #84) — the Job carries an `install_date` to be synced later.

**Data model:** migration creates `jobs` (+ `job_number_seq`).

**Tasks:**
1. `src/lib/jobs.ts` — `createJobFromQuote(quoteId)` (snapshot line items + From-Quote link + `type` from `service_type`), `getJob`, `listJobs`, `setJobStatus`. **Tests:** create-from-quote snapshot correctness; status transitions.
2. Valor webhook — on the existing deposit-paid/booked claim, also `createJobFromQuote` (idempotent — guard on existing job for the quote, mirroring the atomic deposit claim). **Tests:** extend `valor/webhook/route.test.ts` — booking creates exactly one job; replay creates none.
3. `src/app/api/jobs/route.ts` (list, admin-auth) + admin jobs list/detail pages with status + From-Quote link.
4. `src/components/dashboard/WorkflowBoard.tsx` (Naldo's area) — three columns (Quotes·Jobs·Invoices) with per-status counts from `src/lib/dashboard/*` aggregations; matches the approved mockup. Decide placement: replace vs sit beside the existing worklist (SPEC §9).
5. Job "to_schedule" placeholder note ("Scheduling handled in home.works" — #84).

**Done when:** booking a quote auto-creates one linked Job; the board renders live counts; gates green.

## Phase 3 — Invoices (auto) + 50% balance via Valor

**Objective:** Auto-create an invoice when a job is marked Installed/Complete; collect the 50% balance via the saved Valor card, fallback to a portal pay-link.
**Depends on:** P2. Reuses the Valor vault token + hosted-page/webhook patterns.

**Data model:** migration creates `invoices` (+ `invoice_number_seq`).

**Tasks:**
1. `src/lib/invoices.ts` — `createInvoiceFromJob(jobId)` (total from the quote result/snapshot; `deposit_applied` = deposit paid; `balance` = total − deposit; `tax_overridden` carried). **Tests:** balance math incl. tax 8.75% + manual override + amended totals.
2. `src/lib/integrations/valorBalance.ts` — `chargeBalance(invoice)` via the stored `valor_vault_token` (card-on-file sale). **Tests:** request shape (mocked); success/decline mapping.
3. `src/app/api/jobs/[id]/complete/route.ts` (admin-auth) — set job `complete`/`requires_invoicing` → `createInvoiceFromJob` → attempt `chargeBalance`; on success mark `paid` + receipt + HighLevel move; on decline/no-card → status `awaiting_payment` + send portal pay-link. **Tests:** auto-charge success, decline→link, idempotency.
4. `src/app/api/integrations/valor/balance-webhook/route.ts` — verify (HMAC, reuse `valor.ts`) the pay-link payment → mark invoice `paid` + receipt. **Tests:** mirror the deposit webhook tests.
5. Portal `pay-balance` page — reuse the deposit hosted-page flow for the remaining balance.
6. Manual **tax-override** control on the quote/invoice (zeroes/edits tax); **Cancelled** state on quote/job/invoice (refunds stay manual in Valor — no integration).
7. Admin invoices list/detail (deposit-applied → balance → status). No AR/aging view (per scope).

**Done when:** marking a job complete auto-creates an invoice, auto-charges the card (or sends a working pay-link), and flips to Paid on payment; gates green; verified end-to-end on a test quote ($ test charge then voided, as with the deposit go-live).

## Phase 4 — Amend a booked order

**Objective:** Let staff re-open a booked order, add/remove items, and auto-recompute the balance with the deposit still applied + a versioned trail.
**Depends on:** P3 (invoice/balance rails). **Risk:** rewrites the "freeze snapshot / read-only after approval" assumption (approve route 409, portal lock, `SelectionContext.locked`).

**Tasks:**
1. `src/app/api/quotes/[id]/amend/route.ts` (admin-auth) — accept item changes, re-price server-side (reuse `priceSelection`), append an `amendments[]` entry to `approval_snapshot` (who/when/before→after) without overwriting the original signed snapshot; update the linked invoice/balance (`balance = new_total − deposit_paid`).
2. Edge handling: increase → larger balance (collected at install); **decrease below deposit → overpayment flag** for a manual Valor refund (per the cancellation decision).
3. Amend UI (builder/admin "Edit booking"); guard with a confirm.
4. **Open detail to confirm at build:** customer re-notify/re-sign on amendment (default: staff-initiated, optional notice).
**Tests:** re-price correctness, balance recompute, amendment-trail integrity, original-snapshot immutability.
**Done when:** a booked order can be amended, the balance is correct, the original signature/snapshot is preserved, gates green; adversarial review before merge.

## Phase 5 — Customer + Property identity + "rebook last season"

**Objective:** Promote customers to a stable Customer object with one-or-more Properties; one-click clone of last season's approved quote/design.
**Depends on:** P1+ (status); independent of P3/P4.

**Tasks:**
1. Migration creates `customers` + `properties`; backfill from existing quotes (dedupe by HL contact→email→phone→name); link quotes/jobs/invoices.
2. `src/lib/customers.ts` — find-or-create customer/property; attach to quote on save.
3. `rebookLastSeason(customerId, propertyId)` — clone the last approved quote + its design into a fresh draft. **Tests:** clone correctness (line items, design, fresh ids/numbers, new status=draft).
4. Customer/property UI (multi-property) + a "Rebook last season" action on the customer page.
**Done when:** customers have stable identity + properties; "rebook last season" produces a correct fresh quote; gates green.

## Deferred (separate ledger tasks — not in this plan)
- **#84** home.works ↔ tool scheduling connection (the install-date/dispatch sync; resolves the "where Jobs/Invoices live" boundary).
- **#85** Permanent/Glow365 recurring billing.
- **#86** QuickBooks accounting sync.
- **#87** PDF quote/invoice/receipt docs · on-my-way/install-complete texts. (Review requests already via HighLevel.)
- Out: full Visits/crew/route/job-costing, in-tool refunds, tips, ACH, capacity limits, inventory, assessments.

---

## Self-review (against the spec)
- **Spec coverage:** statuses/decline/changes/e-sign (P1) ✓ · auto-Job (P2) ✓ · auto-Invoice + Valor balance auto-charge→link (P3) ✓ · amend-order (P4) ✓ · Customer/Property + rebook (P5) ✓ · display IDs (data model + P1) ✓ · tax 8.75% + manual override (P3) ✓ · Cancelled + manual refunds (P3) ✓ · Workflow board (P2) ✓ · #81 prerequisite (P0) ✓ · deferred items (#84–#87) ✓.
- **Sequencing:** P1→P2→P3 close the deposit-to-paid gap (most Jobber-parity, least risk); P4/P5 are higher-value adds touching the approval model + identity.
- **Open TBDs to resolve before the relevant phase:** where Jobs/Invoices are created (P2, vs home.works/#84); workflow-board placement (P2); amend re-notify/re-sign (P4); display-ID seed (recommend 1000).

## Next step when a phase is greenlit
Generate the phase's granular TDD plan with superpowers:writing-plans (→ `docs/jobber-flow/plans/phase-N.md`), then execute with superpowers:subagent-driven-development. Do not start before #81 (P0) and a Jason coordination check.
