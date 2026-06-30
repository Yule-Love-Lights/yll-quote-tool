# Valor auto-charge ("Charge remaining balance") — heads-up for Jason (#83)

> **From Naldo's side (2026-06-29).** Naldo wants a one-click **"Charge remaining
> balance"** button on a completed job — charge the card saved at deposit, **no
> waiting for the customer to pay an invoice**. I'm building the #83 operator
> surfaces (`/admin/jobs`, `/admin/invoices`, job-complete→invoice, amend) on the
> existing #83 data layer. The **actual card charge touches your Valor/payments
> area**, so it's isolated behind a seam + a flag and is **stubbed until you
> confirm + wire it.** This doc is everything you need to do that part.

## TL;DR — what's mine vs yours

- **Mine (building now, no money movement):** the 4 surfaces + the job-complete
  flow that creates the invoice + recomputes the balance, with the charge routed
  through a clean seam `chargeBalanceOnFile()` behind `VALOR_AUTO_CHARGE_ENABLED`
  (OFF). Until the flag's on, the button creates the invoice and leaves it
  `awaiting_payment` (no charge, no money).
- **Yours (payments area):** confirm the 3 items below, then fill in the real
  Valor charge call in the seam. Nothing in `valor.ts` / the deposit flow changes
  until you do it.

## What I confirmed in Valor's API docs (2026-06-29)

The capability EXISTS and fits our credentials:

- **Endpoint:** `POST {securelink[-staging].valorpaytech.com}/?saleToken` —
  **"Direct Sale - Token"** (`https://valorapi.readme.io/reference/direct-sale-token-api`).
- **Auth:** `appid` / `appkey` / `epi` in the body — **the same creds we already
  hold** (`VALOR_APP_ID` / `VALOR_APP_KEY` / `VALOR_EPI`). No separate bearer.
- **Charges a saved card via** a body field literally named **`token`** =
  *"Card token, received from sale use it only."*
- Fields: `txn_type` ('sale'), `amount`, `tax_amount`, `surchargeAmount`,
  `surchargeIndicator`, `invoicenumber`. Success = HTTP 200 / `error_no` "S00"
  (+ `approval_code`, `rrn`, `txnid`, status "APPROVED"); errors 400.
- Adversarial verdict: **capability + credential-fit CONFIRMED; our specific chain
  has 3 unconfirmed links** (below). Do NOT ship the charge on inference.

## The 3 things only you can confirm (payments area)

1. **Are we even saving the card at deposit?** Our live deposit uses the **hosted
   page** (`createHostedPageSale` → `POST /?pagesale=`) and its request body sends
   **no save-card / vault flag** (only the *unused* `getClientToken` sets
   `save_card=1`). So `quotes.valor_vault_token` is probably **NULL in prod**. →
   Add a vault/save-card flag to the hosted-page request, and verify a real
   (staging) deposit lands a token in the webhook. (We already persist
   `event.vaultToken` → `valor_vault_token` in the webhook route — that plumbing is
   done.)
2. **Is that token chargeable via `/?saleToken`?** The docs show the sale
   success-response body as an empty stub; the only token evidence is a webhook
   example. Confirm the webhook `token` we store is what `/?saleToken` expects —
   vs. needing the separate **valor-vault REST** profile API (different header auth
   `Valor-App-ID`/`Valor-App-Key` + a `vault_id` we don't persist). → One staging
   test: deposit → grab token → charge $1 → void.
3. **MIT / cardholder-not-present + consent.** The `/?saleToken` docs contain **no**
   card-on-file / merchant-initiated / stored-credential / consent wording.
   Charging with no customer present is a stored-credential (MIT) transaction with
   card-network consent rules. → Get Valor's written OK, and we likely add a
   *"keep my card on file, charge my balance at completion"* consent line at
   deposit/approval. Charge **exactly** the balance (same `ignore_surcharge_calc=1`
   concern as the deposit — no portal surcharge/tax re-added).

## Where to drop the charge (the seam I'm building)

`src/lib/integrations/valorBalance.ts` → **`chargeBalanceOnFile({ vaultToken,
amountUsd, orderRef, taxUsd, customerName, customerEmail })`**.

- **Built now (SAFE STUB):** `chargeBalanceOnFile` + `isAutoChargeEnabled` exist
  and are tested. The stub returns `{ ok: false, reason: 'not-enabled' }` when the
  flag is off, `'no-card'` when there's no saved token, and `'error'` (never a
  silent no-op) when enabled-but-unimplemented. It makes **no** Valor call.
- **You fill in** the real `/?saleToken` POST in the `TODO (Jason …)` block (mirror
  `createHostedPageSale`'s style + the `CONFIRM:` defensive parsing in `valor.ts`):
  appid/appkey/epi, txn_type 'sale', amount, `token`=`vaultToken`,
  invoicenumber=`orderRef`; parse `error_no 'S00'` → `{ ok:true, … }`.
- **Flow as built (two operator steps):** "Mark installed & create invoice"
  (`jobs/[id]/complete` — advances the job + creates the invoice, balance
  computed) then a separate **"Charge remaining balance"** action on the job detail.
  That button is **DISABLED today** (the seam is gated). The thin charge ROUTE that
  calls `chargeBalanceOnFile` → on 'S00' marks the invoice `paid` + closes the job;
  on decline/no-token → `awaiting_payment` — is the last piece, wired once your 3
  confirmations pass. `planBalanceCollection` (existing pure routing) chooses
  auto_charge-vs-pay_link. (When the balance ≤ 0 because the deposit covered the
  total, complete already settles it `paid` — no charge needed.)

## Go-live (same discipline as the #38 deposit)

Confirm 1–3 → wire `chargeBalanceOnFile` → **real $ test charge then void** on
staging → flip `VALOR_AUTO_CHARGE_ENABLED` in Vercel Production. Instant rollback =
unset the flag (the surface degrades to "create invoice, awaiting payment").

## Review follow-ups also flagged for you (from the adversarial reviews)

Two need your sign-off because they touch the **live deposit-booking path** /
need a migration; the rest are noted as context.

1. **⚠️ Deposit webhook doesn't verify the paid AMOUNT (HIGH, pre-existing).** The
   deposit branch stamps `deposit_paid_at` + `status='booked'` on any approved txn
   matching `valor_order_ref`, **without comparing `event.amountUsd` to the intended
   `quotes.deposit_amount_usd`** — even though `/pay` persists that value precisely
   *"so the webhook can verify the confirmed amount."* An approved underpaid deposit
   books the quote + cascades (job, auto-PO, receipts). I **fixed the symmetric bug
   on the new BALANCE branch** (it now refuses to settle on a shortfall), but left
   the **deposit** path alone — it's live in prod + your area. Mirror the same guard
   when you're comfortable (`event.amountUsd >= deposit_amount_usd`, 1-cent
   tolerance, log+ignore a shortfall).
2. **Settled-amount audit column (needs a migration).** The balance branch records
   the txn id + receipt URL but not the settled dollar amount (no column). A
   `migrations/*: ALTER TABLE invoices ADD COLUMN balance_paid_usd numeric` + persist
   `event.amountUsd` would make balance reconciliation auditable. Deferred (no
   migration this session).
3. **Atomic amendment-trail append (durable fix).** `POST /api/quotes/[id]/amend`
   read-modify-writes `approval_snapshot.amendments[]`. I added a re-read
   concurrency guard + the UI disables the button mid-request, so double-click/retry
   is covered — a true-simultaneous two-operator amend could still drop a trail
   entry (no money moves; audit-trail only). `quotes` has no `updated_at` trigger to
   optimistic-lock on → the fully-atomic fix is a small **Postgres RPC**
   (`approval_snapshot = jsonb_set(..., amendments || $1)`). Worth adding when convenient.
4. **Tax-override is now BUILT** (this session): `setInvoiceTaxOverride` + a PATCH
   route + a toggle on the invoice detail. Residual: the amend trail's `new_total`
   doesn't yet use the tax-adjusted total when an invoice is tax-overridden (rare;
   they only diverge once an override exists). Worth aligning if you touch it.

## PR

The surfaces land in a PR off `naldo/jobber-surfaces` — Jason's area + shared data
layer, so **your review before Naldo merges.** Nothing in `valor.ts` or the
deposit flow is touched in that PR; the seam is a new file.
