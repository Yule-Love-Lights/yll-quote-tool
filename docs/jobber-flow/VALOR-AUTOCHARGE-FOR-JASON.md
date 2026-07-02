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

---

# UPDATE — 2026-07-02 (Naldo S21): research refresh + DECISION

> Ran a 9-agent research + adversarial-verify workflow (5 doc-sweep → 3 refute-lens
> verifiers → synthesis) against the LIVE Valor docs to settle "can we finish
> auto-charge." **Verdict: `yes-needs-one-live-test` — NOT doc-confirmable.** All 3
> verifiers refuted "it works as documented"; all 3 said only a Valor staging test
> settles it. **Naldo's call: SHIP THE PAY-LINK, call #83 functionally done; keep
> auto-charge alive as a Jason-gated follow-up (do NOT scrap, do NOT build blind).**

## What we CONFIRMED (narrows the original "3 unconfirmed links")

The capability *architecture* exists and every endpoint takes creds we hold. The
full chain, when/if built:

| Step | Endpoint | Auth | Notes |
|---|---|---|---|
| 0. Deposit (LIVE) | `POST {securelink}/?pagesale` | BODY `appid`/`appkey`/`epi` | Returns only `{error_no,url,uid}` — **no `ref_txn_id`/`token`** in the response; those must come from the confirmation **webhook** (we already persist a token → `quotes.valor_vault_token`) or a txn lookup. |
| 1. Create vault profile | `POST /api/valor-vault/addcustomer` | HEADER `Valor-App-ID`/`Valor-App-Key` | Returns `vault_customer_id` (= the `vault_id`). **Vault is a premium ISO add-on** — may not be provisioned for our EPI. |
| 2. Vault the deposit card | `POST /api/valor-vault/addpaymentprofiletxn/{vault_id}` | HEADER auth | Body `ref_txn_id` (from step 0's webhook). |
| 3. Read back the token | `GET /api/valor-vault/getpaymentprofile/{vault_id}` | HEADER auth | Returns each card's reusable `token` + `payment_id` + `masked_pan`. |
| 4. Charge the balance | `POST {securelink}/?saleToken` | BODY `appid`/`appkey`/`epi` | `token` = step-3 token, `amount`, `invoicenumber`. **No customer present.** |

## The blockers that keep this from being doc-confirmed (the honest gambles)

1. **🚩 "Virtual Terminal ONLY" (biggest unknown).** Valor's official *Vault User
   Guide* (Nov 2024) states verbatim that saved Vault cards **"can only be processed
   through the Virtual Terminal"** (a human UI) — zero mention of API. This directly
   contradicts a server-initiated API charge and may mean the API path is **disabled
   for our EPI**. Must get Valor's written OK that API token-charging is enabled.
2. **Token-linkage (the crux).** No doc states the `getpaymentprofile` token is a
   valid input to `/?saleToken`. Its help text literally says *"Card token, received
   from sale use it only"* — which points at a sale-echoed token and may forbid
   delayed reuse. Equivalence is pure 40-char-hex format-matching. Unproven.
3. **Auth/host crossing.** Vault calls are header-auth on `demo.valorpaytech.com`
   (prod vault base URL is **undocumented**); the charge is body-auth on
   `securelink`. Docs never confirm the header creds equal our body creds.
4. **Truncated success schemas.** `/?saleToken` + `addpaymentprofiletxn` render 200
   responses as `{}` — we can't even see from docs that a token sale returns an
   `approval_code`.
5. **MIT / stored-credential consent (compliance).** No Valor endpoint exposes an
   MIT/stored-credential indicator field. Visa/MC require an initial
   cardholder-authorized consent + a stored-credential indicator on every
   merchant-initiated charge. Our epage deposit captures **no** "keep card on file"
   consent today. This must be added at deposit regardless, and Valor must confirm
   they set the network indicator.

## The ONE test that settles it (when Valor access is available)

Staging (`securelink-staging` + `demo.valorpaytech.com`), Valor test card:
deposit → `addcustomer` → `addpaymentprofiletxn(ref_txn_id)` → `getpaymentprofile`
→ `POST /?saleToken(token, $1)` **with no customer present** → expect APPROVED →
void. In parallel, email Valor for **4 written confirmations**: (a) API
token-charging enabled for our EPI, (b) `getpaymentprofile` token valid + reusable
as a `/?saleToken` input, (c) MIT/stored-credential indicator set automatically,
(d) the production vault base URL.

## What SHIPPED instead (S21) — the balance-collection method for the trial

**The customer PAY-LINK.** Operator opens the invoice → **"Copy customer pay-link"**
→ sends the `/portal/[quoteId]/pay-balance` URL (the customer taps + pays the 50%
balance on Valor's hosted page; the `bal_<quoteId>` webhook branch settles it). This
is LOW effort (reuses the LIVE epage + webhook), **fully doc-confirmed**, and
**compliant** (cardholder present each charge — no MIT/consent problem). The dormant
disabled "Charge remaining balance" button was **removed from the operator UI**
(the `BalanceChargeButton` stub was deleted + unmounted from the job/invoice detail
pages) so the trial surface has no dead control; the `valorBalance.ts`
`chargeBalanceOnFile` seam + the `VALOR_AUTO_CHARGE_ENABLED` gate stay in the
codebase for when you wire step 4 (re-add a button then).

## Ranked fallbacks (from the synthesis)

1. **Pay-link** (shipped) — low effort, doc-confirmed, compliant; customer taps to pay.
2. **Server auto-charge via `/?saleToken`** (the chain above) — the true one-click
   UX; MEDIUM code but BLOCKED on the staging test + Valor confirmations above.
3. **Recurring/Subscription API** (`/?addSubs` Run-at → `/?activateSub` → delete) —
   same vault/token uncertainty + more moving parts; only worth it for a real
   installment product.
4. **Manual charge in Valor's Virtual Terminal** — zero code, the one stored-card
   path Valor authoritatively supports today (needs the Vault add-on + operator
   training); a stopgap if pay-link drop-off is a problem.
5. **Scrap auto-charge**, keep two hosted-page links (deposit + balance) — lowest
   risk, fully compliant.
