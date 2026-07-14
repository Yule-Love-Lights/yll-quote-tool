# Wisetack financing on the customer portal (Task #154)

**Date:** 2026-07-14 · **Session:** S38 · **Author:** Naldo (assistant-drafted)
**Area:** Jason's (portal, quote, pricing/balance, admin quotes) + SHARED money path. Jason reviews before merge; this is a customer-facing money change.

## Goal

Let a customer finance their lighting project from the portal. The customer still pays the 50% deposit through Valor as they do today, and finances the remaining 50% balance through Wisetack instead of paying that balance later by card. The option appears at the approve/deposit step.

## Decisions locked (Naldo, 2026-07-14)

1. **Account:** YLL already has a Wisetack merchant account.
2. **Depth:** Full API integration (server creates the financing transaction, receives status webhooks, reflects status in-tool). Not just a static prequal link.
3. **Scope:** Both holiday and permanent quotes. Show only when the financed amount is inside Wisetack's loan range.
4. **Deposit model (Option B):** Take the Valor 50% deposit as normal. Finance only the 50% balance through Wisetack.
5. **Placement:** At the approve/deposit step (same session, right after the deposit).

## Why Option B is the lower-risk choice

The quote's booking trigger does not change. Today the Valor deposit-paid webhook books the quote. Under Option B that stays exactly as-is, so financing never touches the booking path. Wisetack only handles the balance that a second Valor charge would otherwise collect. If Wisetack declines the balance loan, nothing is stuck: the balance reverts to the normal Valor collection path.

## What Wisetack gives us (grounded 2026-07-14)

- Consumer installment loans **$500 to $25,000**, 0 to 35.9% APR. Customer applies via a text link in about 2 to 5 minutes.
- Merchant fee **3.9%**. Wisetack pays YLL the financed amount minus 3.9% by ACH, 1 to 3 business days after job-completion is confirmed.
- Application lifecycle (statuses): **Sent, Started, Authorized** (Wisetack approves the loan), **Accepted** (customer accepts terms), **Confirmed** (customer confirms for payment), **Settled** (merchant paid). Negative terminals: **Declined, Expired, Canceled, Refunded**.
- API-first REST integration with webhook reporting.
- Exact endpoint names, auth scheme, webhook-signature scheme, sandbox credentials, and whether a monthly-estimate endpoint exists are **behind the Wisetack partner account** and get confirmed in Phase 0. Nothing in this spec hardcodes an endpoint before that confirmation.

## Money math (integer cents throughout)

- `total_cents` = full quote total including tax, taken from the **agreed selection** (the same source `loadPortalQuote` / `getInvoiceDetail` use, so it reconciles on partial approvals).
- `deposit_cents` = the existing portal deposit figure. Reuse the current computation; do not introduce a second deposit formula.
- `balance_cents = total_cents - deposit_cents`. The deposit and balance must sum back to `total_cents` to the cent.
- **Financed amount = `balance_cents`.**
- **Eligibility to show financing:** flag on, `serviceType` is `holiday` or `permanent`, and `balance_cents` is in `[50000, 2500000]` ($500 to $25,000). A job whose balance is under $500 does not qualify (below Wisetack's floor) and the option is hidden.

## Architecture

New and changed pieces, each with one clear job.

### 1. `src/lib/wisetack/client.ts` (new)
Thin REST wrapper over the Wisetack API: create transaction, get transaction status, and (if the API supports it) fetch a monthly estimate. Reads config from env. Structured like the existing Valor client so the two read the same way. No business logic here, just transport plus typed responses.

### 2. Config / env (new)
- `WISETACK_API_KEY`
- `WISETACK_ENV` (`sandbox` | `production`)
- `WISETACK_WEBHOOK_SECRET`
- `WISETACK_MERCHANT_ID` (if the API requires it)
- `WISETACK_FINANCING_ENABLED` (kill switch; server-side only)

Added to `.env.local` and Vercel by Naldo. No `NEXT_PUBLIC_*` flag: the portal server component computes eligibility and passes `financingEligible` + `balanceCents` as props, so the flag never ships to the client.

### 3. `wisetack_transactions` table (new, migration-first)
Columns: `id`, `quote_id` (FK to quotes, `ON DELETE CASCADE` to match the jobs/invoices FK convention), `wisetack_transaction_id`, `amount_cents`, `status`, `application_url`, `created_at`, `updated_at`. Plus a readable financing marker on the quote (a `financing_status` column or a lightweight join). Additive and nullable, so it ships migration-first (the column must exist before code reads or writes it).

### 4. `POST /api/quotes/[id]/finance` (new)
Customer-initiated from the portal. Server loads the quote, verifies it is approved with a stable agreed selection, computes `balance_cents`, range-checks it, calls Wisetack create-transaction (customer name / phone / email + amount + `quoteId` as the external reference), stores a `wisetack_transactions` row, and returns the application URL. **Idempotent:** if a non-terminal Wisetack transaction already exists for the quote, return it instead of creating a duplicate.

### 5. `POST /api/webhooks/wisetack` (new)
Receives Wisetack status webhooks. Verifies the signature (reject unsigned or forged), parses the event, and updates the `wisetack_transactions` row **idempotently** (keyed by transaction id plus event/status; stale or duplicate deliveries are no-ops). Reconciliation by status:
- Authorized / Accepted / Confirmed: mark balance financing in progress or secured.
- **Settled:** mark the balance **paid via financing**; feed the balance-collection surface (#83) as a financed path rather than a Valor balance charge.
- Declined / Expired / Canceled: mark financing failed; the balance reverts to normal Valor collection.
- Refunded: handle a post-settle reversal.

This webhook **never books the quote.** Booking stays with the Valor deposit-paid webhook.

### 6. Portal UI (changed)
In the approve/deposit area (`StickyBottomBar` / `QuoteResponseModal` / `DepositCheckout`), when `financingEligible` is true, present a secondary option next to "Pay your 50% deposit": **"Finance the 50% balance monthly with Wisetack."** Because the Valor deposit redirects off-site to Valor's hosted page and returns to `/portal/[id]/approved`, the balance-financing application is framed at the approve step and kicked off from the post-deposit `/approved` return page (the natural, reliable mount point). That still satisfies "at the approve/deposit step": same session, immediately after the deposit. For the pre-application display, show "Finance monthly with Wisetack" and let Wisetack's hosted flow show the real monthly figure. Only show a specific "from ~$X/mo" number if Phase 0 confirms a reliable estimate endpoint.

### 7. Operator visibility (changed)
`/admin/quotes/[id]` shows the financing status (none / applied / authorized / confirmed / settled / declined) and the financed amount. **Job-completion confirmation that triggers the Wisetack payout is done in Wisetack's own merchant portal for v1**, to keep this build small. Our tool reflects the resulting status; it does not drive the payout in v1.

## Guardrails (money feature, test-first)

Write these as failing tests from the acceptance criteria before implementing:
- Integer cents only; `deposit_cents + balance_cents === total_cents` with no float drift.
- Financing shown only when `balance_cents` is in `[50000, 2500000]`, flag on, and `serviceType` is holiday or permanent (positive-match gating).
- Webhook idempotency: duplicate and out-of-order deliveries do not double-apply.
- Webhook signature verification: unsigned or forged payloads are rejected.
- No double-book: a financing webhook can never flip booking state; only the deposit path books.
- Valor path isolation: with financing unused or the flag off, the existing deposit and balance flows are byte-for-byte unchanged.
- Decline / expire path: leaves the balance collectable by Valor, no stuck "awaiting financing" state.
- Amend interaction: if the quote is amended after a financing transaction is created, the stale transaction is canceled or re-issued so the financed amount can never disagree with the agreed total.

Process guardrails: full sandbox end-to-end before any prod flip; the flag stays OFF in prod until Naldo flips it and live-verifies; rollback lever is the flag (or revert the PR). A money-math verdict and an adversarial review run before merge (Fable-eligible per the routing policy).

## Phasing (checkpoint cadence, gated per phase)

- **P0, API surface + sandbox.** Confirm the exact Wisetack endpoints, auth, webhook-signature scheme, status names, and whether an estimate endpoint exists. Obtain sandbox credentials and put them in `.env.local`. Some of this is Naldo / Wisetack-side. Deliverable: a confirmed integration note plus working sandbox creds.
- **P1, Backend, flag OFF.** Migration (`wisetack_transactions` + quote financing marker), `wisetack/client.ts`, `POST /finance`, `POST /webhooks/wisetack`. Unit and integration tests against the sandbox. No UI.
- **P2, Portal + operator UI.** Financing CTA driven by server-computed eligibility, financed states on `/approved`, financing status on `/admin/quotes/[id]`.
- **P3, Balance reconciliation + edges.** Wire the settled financing into the #83 balance-collection surface; handle amend, decline, and refund edges.
- **P4, Sandbox E2E then go-live.** Full sandbox run (approve, pay deposit, finance balance, drive Wisetack sandbox statuses through Settled, confirm balance reconciled). Then Naldo flips `WISETACK_FINANCING_ENABLED` in prod and live-verifies with an `is_test` quote.

## Out of scope for v1

- Driving job-completion confirmation (the Wisetack payout trigger) from inside our tool. Done in Wisetack's portal for v1.
- Financing the full ticket or replacing the deposit (that was Option A, not chosen).
- Refund and dispute automation beyond reflecting the status.
- A hardcoded monthly-payment estimate if Phase 0 finds no reliable estimate endpoint.

## Open items to confirm in P0

- Exact Wisetack endpoint names, request/response shapes, and auth header.
- Webhook signature scheme and the `WISETACK_WEBHOOK_SECRET` format.
- Whether a monthly-estimate endpoint exists for the pre-application "from $X/mo" display.
- Whether the customer is texted the link by Wisetack automatically on create, or we surface the link ourselves.
- Sandbox environment base URL and test credentials.
