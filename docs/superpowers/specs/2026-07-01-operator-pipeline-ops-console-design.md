# Operator pipeline ops console — design spec

**Date:** 2026-07-01
**Author:** Naldo (assistant-built)
**Task:** builds on #83 Jobber-flow surfaces (PR #251, merged `44a48b9`). Ledger: new task (operator manual pipeline actions + nav/details).
**Status:** design approved (brainstorming), pending plan.

## 1. Problem / goal

The #83 Jobber-flow pipeline (Quote → Job → Invoice → Paid) is built, but movement is almost entirely **automatic** (deposit webhook books + creates the job; job-complete auto-creates the invoice; Valor balance webhook settles it). Real ops need **operator overrides** to move a record through the process by hand — phone approvals, cash/check/offline payments, manual bookings — plus consistent navigation and detail views.

Deliver:
1. **Nav:** `Quotes | Jobs | Invoices` reachable from the top bar **and** a consistent billing tab strip.
2. **Details:** a real per-record detail view for all three (quotes currently have none).
3. **Options menu:** one **status-aware** operator actions menu on the customer page + all three admin lists, exposing the pipeline transitions as buttons.

## 2. Locked decisions (from brainstorming)

- **Nav = Both:** add `Jobs` + `Invoices` to the top `OperatorNav`, **and** fix the `BillingSubNav` strip to render on all three billing pages.
- **Convert to job = operator enters deposit:** a deposit field (can be `$0` or an amount); books the quote + creates the job with **no Valor charge**.
- **Manual pay = just mark paid:** simple status flip, **no** method/note/paid-by columns → **no DB migration**. Reuses existing `deposit_paid_at`/`deposit_amount_usd` (quotes) and `paid_at`/`balance`/`status` (invoices).
- **Mark approved = staff-approve, tagged, no e-sign:** records operator approval in `approval_snapshot.staffApproved` (jsonb — no migration); moves `sent/viewed → approved`.
- **Send = Email + Text + keep combined:** three send affordances (email-only, text-only, both).
- **Quote details = new `/admin/quotes/[id]` read-only page** (parity with jobs/invoices).
- **Options menu = everywhere + status-aware:** customer page + all three admin lists; shows only the actions legal for the record's current status.
- **Close = finalize:** mark the invoice paid (if unpaid) + move the job to `done`.
- **Approach A, 2 PRs:** shared menu + pure action core; PR1 = nav/details (no money), PR2 = action menu + money routes (adversarial review).

## 3. Grounding (current state — verified)

Status machines (pure, `canTransition(from,to)` against a static table):
- Quote (`src/lib/quoteStatus.ts:16-25,118-128`): `draft|sent|viewed|approved|booked|changes_requested|declined|cancelled|lost`. Forward path `draft→sent→viewed→approved→booked`; `approved→[booked,cancelled]`; `booked→[cancelled]`.
- Job (`src/lib/jobStatus.ts:11-17,33-40`): `to_schedule|scheduled|installed|requires_invoicing|done|cancelled`.
- Invoice (`src/lib/invoiceStatus.ts:13,29-34`): `draft|awaiting_payment|paid|cancelled`; `draft→[awaiting_payment,paid,cancelled]`, `awaiting_payment→[paid,cancelled]`.

Transition functions (reuse, don't reinvent):
- `createJobFromQuote(quoteId)` idempotent on `quote_id` (`src/lib/jobs.ts:233-326`).
- `setJobStatus` guards via `canTransition`, stamps `completed_at` on `done` (`src/lib/jobs.ts:334-354`).
- `createInvoiceFromJob(jobId)` idempotent on `job_id`, prices off live `quote.result` (`src/lib/invoices.ts:331-428`).
- `setInvoiceStatus` guards + stamps `paid_at` on `paid` (`src/lib/invoices.ts:436-461`).

Existing routes we extend/adjacent to:
- `POST /quotes/[id]/send` fires **both** SMS + email (`src/app/api/quotes/[id]/send/route.ts:300-330`); `is_test` simulates (`:206-210`).
- `POST /quotes/[id]/approve` is **public** (customer), server-recompute + e-sign + freeze snapshot, atomic `.is('customer_approved_at',null)` (`src/app/api/quotes/[id]/approve/route.ts:503-515`).
- `POST /jobs/[id]/complete` advances to `requires_invoicing` + `createInvoiceFromJob`; settles paid + job done when `balance<=0` (`src/app/api/jobs/[id]/complete/route.ts:32-117`).
- `POST /jobs/[id]/cancel` cancels job+invoice+quote (`src/app/api/jobs/[id]/cancel/route.ts:45-93`).
- `POST /quotes/[id]/amend` (booked-only, appends `approval_snapshot.amendments[]`, re-syncs invoice) (`src/app/api/quotes/[id]/amend/route.ts:99-223`).
- `PATCH /invoices/[id]` only toggles tax-override (`src/app/api/invoices/[id]/route.ts:31-54`).
- Deposit "paid" = webhook atomic claim `.is('deposit_paid_at',null)` → `status=booked` → `createJobFromQuote` (`src/app/api/integrations/valor/webhook/route.ts:260-303`). Balance "paid" = `bal_` branch, atomic `.neq('status','paid')`, then job `requires_invoicing→done` (`:486-533`).
- `requireOperator()` dormant unless `AUTH_GATE_ENABLED==='true'` (`src/lib/auth/supabaseServer.ts:137-141`).

Nav / surfaces:
- Top bar = `OperatorNav` (`src/components/dashboard/OperatorNav.tsx:13-21`) — items Home/Inbox/Customers/**Quotes**/Inventory/Insights/Settings. Rendered by `OperatorShell` (`src/components/OperatorShell.tsx:30`).
- `BillingSubNav` (`src/components/admin/BillingSubNav.tsx:8-12`) has all three tabs but is **not mounted on the quotes list page** (`src/app/admin/quotes/page.tsx` has a `← Home` link instead) → the reported bug.
- Lists: quotes rows have Edit/Portal/Send/Delete, **no Details** (`src/app/admin/quotes/page.tsx:313-349`); jobs/invoices rows already have a `Detail` link to `/admin/jobs|invoices/[id]`. **No `/admin/quotes/[id]/page.tsx`** (only a `video` subroute).
- Customer detail: `src/app/customers/[contactId]/page.tsx:157-183` — quote-history table with a single `Open` link.

## 4. Architecture

### 4.1 Core — `pipelineActions(record): PipelineAction[]` (pure, PR2)

```ts
type PipelineRecord = {
  quoteId: string
  quoteStatus: QuoteStatus
  isTest: boolean
  depositPaid: boolean
  job?: { id: string; status: JobStatus }
  invoice?: { id: string; status: InvoiceStatus; balance: number }
}

type PipelineAction =
  | { kind: 'send'; channel: 'email' | 'sms' | 'both' }
  | { kind: 'mark-approved' }
  | { kind: 'convert-to-job' }      // opens deposit prompt
  | { kind: 'mark-complete' }       // existing /jobs/[id]/complete
  | { kind: 'collect-payment' }     // invoice mark-paid
  | { kind: 'close' }               // finalize: mark paid + job done
  | { kind: 'amend' }               // existing
  | { kind: 'cancel' }              // existing, destructive → confirm
  | { kind: 'details'; href: string }
```

Legality is a thin wrapper over the existing `canTransition` tables, so the action set can never offer an illegal move. New file `src/lib/pipeline/pipelineActions.ts` + `pipelineActions.test.ts` (every status → expected set). Mapping = the table in §1 of the design (draft→send/details; sent/viewed→send/mark-approved/details; approved→convert-to-job/details; booked+job→mark-complete/amend/cancel/details; requires_invoicing+unpaid→collect-payment/close/amend/cancel/details; paid/done→details; terminal→details).

### 4.2 New operator routes (PR2)

All: `requireOperator()` (defense-in-depth, dormant), reject illegal transitions via the existing guards (throw → 409), atomic/idempotent claim writes, `is_test`-safe (suppress real GHL/notify; still record local status). None move real money.

1. **`POST /api/quotes/[id]/staff-approve`** — `sent|viewed → approved`. Atomic `.is('customer_approved_at', null)` writes `customer_approved_at=now`, `status='approved'`, and `approval_snapshot.staffApproved = { by: operatorId|null, at }`. Skips e-signature. Server-recompute of total/deposit like the customer approve route so the snapshot is trustworthy. `is_test`: no real notify.
2. **`POST /api/quotes/[id]/convert-to-job`** — body `{ depositUsd: number }` (`>= 0`; if `> total`, clamp + warn). `approved → booked`. Atomic `.is('deposit_paid_at', null)` writes `deposit_paid_at=now`, `deposit_amount_usd=depositUsd`, `status='booked'` (no `valor_txn_id` — manual is inferred from its absence). Then `createJobFromQuote(id)` (idempotent). No Valor charge. `is_test`: test quote → test job (mirrors `simulate-deposit`).
3. **`POST /api/invoices/[id]/mark-paid`** — Collect payment. `draft|awaiting_payment → paid`. Atomic `.neq('status', 'paid')` writes `status='paid'`, `balance=0`, `paid_at=now`. Does **not** force the job to `done` (that's Close).
4. **`POST /api/jobs/[id]/close`** — Finalize. If the linked invoice is unpaid, mark it paid (reuse #3's logic); then `setJobStatus(job, 'done')` (legal from `requires_invoicing`; from `installed` step through `requires_invoicing`). Rejects a `cancelled`/`done` job.
5. **Extend `POST /api/quotes/[id]/send`** — accept `{ channel?: 'email' | 'sms' | 'both' }` (default `'both'` for back-compat). Gate the SMS block and the email block on `channel`. Status/stamp behavior unchanged.

### 4.3 Client — `<PipelineActionsMenu>` (PR2)

- `src/components/admin/PipelineActionsMenu.tsx` — a dropdown styled like the existing row buttons. Renders `pipelineActions(record)`; `convert-to-job` opens a small deposit-amount prompt (prefilled with the standard 50% for convenience); `cancel`/`close` confirm. On success → refetch/refresh.
- Mounted on: customer page quote-history rows (`customers/[contactId]/page.tsx`), and the `/admin/quotes`, `/admin/jobs`, `/admin/invoices` list rows (trailing actions `<td>`). On the quotes list, it **consolidates** the existing Edit/Portal/Send/Delete (which already overflow the row per the code comment) into the menu; keeps a bare `Details` link.
- **Payload enrichment:** the quotes list API (`/api/quotes`) and the customer page's quote loader include each quote's linked `job {id,status}` and `invoice {id,status,balance}` (one lookup by `quote_id`) so the menu is status-aware. Jobs/invoices lists already carry their own status.

### 4.4 PR1 — nav + details (no money)

- **`OperatorNav`** (Naldo area): add `{ label:'Jobs', href:'/admin/jobs', match:['jobs'] }` and `{ label:'Invoices', href:'/admin/invoices', match:['invoices'] }`. Add `'jobs'`/`'invoices'` to the `OperatorArea` union in `OperatorShell.tsx` (small shared touch — flag Jason) and pass the correct `active` on the jobs/invoices pages (currently `active="quotes"`).
- **Strip fix:** add `<BillingSubNav active="quotes" />` to `src/app/admin/quotes/page.tsx` (one line, matching jobs/invoices). No layout refactor.
- **New `/admin/quotes/[id]/page.tsx`** (read-only server component): customer, status + timeline (sent/viewed/approved/booked stamps), line items, totals/deposit/balance, linked job + invoice (with links), amendments trail, portal link. Reuses existing loaders (`getQuoteRaw`, job/invoice lookups).
- **Details buttons:** add a `Details` link → `/admin/quotes/[id]` on the quotes list; jobs/invoices already have theirs.

## 5. Data model

**No migration.** All state reuses existing columns:
- Convert-to-job: `quotes.deposit_paid_at`, `quotes.deposit_amount_usd`, `quotes.status`.
- Staff-approve: `quotes.customer_approved_at`, `quotes.status`, `quotes.approval_snapshot` (jsonb `staffApproved`).
- Mark-paid / close: `invoices.status`, `invoices.balance`, `invoices.paid_at`; `jobs.status`, `jobs.completed_at`.
- Manual vs Valor deposit distinguished by `valor_txn_id IS NULL`.

Money unit stays `numeric(10,2)` USD (matches existing invoices/quotes columns; not integer cents).

## 6. Testing + safety

- **Pure:** `pipelineActions.test.ts` — every quote/job/invoice status combination → expected action set (incl. terminal = details-only).
- **Routes (TDD, red→green):** each new route — legal transition enforced (illegal → 409), **double-call idempotency** (atomic claim; second call is a no-op, no double job-create/close), `is_test` safety (no real GHL/charge), auth gating present, `depositUsd >= 0`, `mark-paid` only settles from legal states, `close` finalizes correctly.
- **Gates** (`tsc · lint · vitest`) green after every phase.
- **PR2 adversarial review** (multi-agent, money + Jason area) before merge; disposition each finding. Focus: idempotency/double-click, status legality, `is_test` leakage, confirm no path fires a real Valor charge, atomic claim correctness.

## 7. Area ownership / merge

- **Naldo:** `OperatorNav` (`src/components/dashboard/**`).
- **Jason (PR'd + flagged, Naldo gives merge-go):** all new routes (`src/app/api/quotes|jobs|invoices/**`), `/admin/**` pages, `customers/[contactId]/page.tsx`, `OperatorShell.tsx`, `pipelineActions` in `src/lib/**`, `PipelineActionsMenu`. Specifically flag Jason on the `staff-approve`/`convert-to-job` ↔ `approval_snapshot`/amend interaction (his amend route reads `approval_snapshot`).
- Human-merges-only; no auto-charge anywhere in this work (Valor auto-charge stays the separate gated item).

## 8. Sequencing

- **PR1 (`naldo/jobber-ops-nav`):** §4.4 — OperatorNav + strip fix + `/admin/quotes/[id]` + Details buttons. No money, low-risk.
- **PR2 (`naldo/jobber-ops-actions`):** §4.1–4.3 — `pipelineActions` core + routes + `PipelineActionsMenu` + payload enrichment + send channel split. Money → adversarial review.

## 9. Out of scope / not included

- Operator "Mark declined/lost" housekeeping and amend/re-send from the menu (can add later if wanted).
- Decline / request-changes stay customer-side (portal).
- Valor card-on-file **auto-charge** (separate gated item — `VALOR_AUTO_CHARGE_ENABLED`).
- Payment method/note/paid-by capture (deferred — "just mark paid" chosen).
- No AR/aging (Naldo opted out).

## 10. Success criteria

- Top bar shows Quotes/Jobs/Invoices; the billing strip shows on all three pages.
- Every list + the customer page has a status-aware Options menu that only offers legal actions and moves the record correctly (send email/text/both, staff-approve, convert-to-job with deposit, collect-payment, close, mark-complete, amend, cancel).
- Quotes have a `/admin/quotes/[id]` detail page; all three lists have Details.
- `pipelineActions()` and every new route are TDD-covered; gates green; PR2 adversarially reviewed; no real Valor charge on any manual path; nothing merged without Naldo's go.
