# Test Quote — implementation plan (#93)

Spec: `docs/superpowers/specs/2026-06-28-test-quote-design.md`. Build TDD, one PR (or a small stack), gates green (`tsc`·`lint`·`vitest`), branch `naldo/test-quote` off FRESH master. Apply the migration to prod before merge. **Re-ground the exact lines first** — #81 auth + #82 inventory landed recently.

## Phase 0 — data foundation (the `is_test` flag)
- Write `migrations/2026-06-28-quotes-add-is-test.sql` (idempotent `ADD COLUMN is_test boolean NOT NULL DEFAULT false` + index). Apply to prod.
- `src/lib/quotes.ts`: thread `is_test` into `saveQuote()` (write) + `listQuotes()` SELECT (read). Add `deleteTestQuotes()`.
- `src/lib/jobs.ts`: `createJobFromQuote()` carries `is_test` (decide: join on `quote_id` vs denormalized column — prefer the join unless a hot path needs the column).
- **Tests:** `saveQuote` persists `is_test`; `deleteTestQuotes` only deletes test rows; the job derives `is_test` from its quote.
- ✅ Done when: a row can be created/read/deleted as test, and a job knows it's test.

## Phase 1 — entry + builder (create a test quote)
- `src/app/settings/page.tsx` `QuotesTab`: add **"Make New Test Quote"** → `/quote/new?test=1`.
- `/quote/new` + `src/components/quote/QuoteBuilder.tsx`: read `?test=1`, carry `isTest` into the save call → `is_test=true`; render a persistent **TEST MODE** banner.
- **Tests:** the builder save path sends `is_test` when `?test=1`.
- ✅ Done when: clicking the Settings button opens the builder in TEST MODE and Calculate saves a test quote.

## Phase 2 — isolation (exclude from real data; badge)
- `src/lib/dashboard/queries.ts` `listQuotesForDashboard()`: add `.eq('is_test', false)` (single chokepoint). Verify `customers.ts` / `dashboard/customers.ts` route through it; patch any direct quote read.
- `/admin/quotes`: add a **TEST** badge on test rows (uses the `is_test` from `listQuotes`).
- **Tests:** `listQuotesForDashboard` excludes test quotes → dashboard metrics/customers/worklist never count them.
- ✅ Done when: a test quote is invisible in dashboard numbers + the customer list, visible+badged in `/admin/quotes`.

## Phase 3 — simulate the flow (suppress externals; reach Job)
- `send/route.ts`: when `is_test`, skip GHL SMS/email + stage-sync; still stamp `quote_sent_at`.
- `approve/route.ts`: when `is_test`, skip the staff-notify email; still write the snapshot.
- NEW `src/app/api/quotes/[id]/simulate-deposit/route.ts` (operator-gated): stamp `deposit_paid_at` + call `createJobFromQuote` (the same path the Valor webhook uses). Guard: refuse on a non-test quote.
- Portal pay UI (`DepositCheckout` / the pay button): when `is_test`, render **"Simulate deposit paid"** → POST the new route (no Valor redirect).
- **Tests:** send/approve don't call the integrations when `is_test`; `simulate-deposit` creates a Job + 400s on a non-test quote.
- ✅ Done when: you can drive a test quote send → approve → "Simulate deposit paid" → a TEST Job exists, zero real messages/charges.

## Phase 4 — inventory safety (visible, but inert on real stock)
- `src/lib/inventory/purchaseOrder.ts` `buildSupplierPurchaseOrder()`: exclude `is_test` jobs (no test needs in the real supplier PO).
- `src/lib/inventory/jobs.ts` `prepareJobMaterials()`: for a test job, do NOT decrement real `inventory_on_hand` (no-op the deduction; still advance/mark prepped).
- `/inventory/jobs`: TEST badge on test job cards.
- **Tests:** PO excludes a test job; `prepareJobMaterials` leaves on-hand untouched for a test job but still advances it.
- ✅ Done when: a test Job appears + moves through the fulfillment Kanban + opens a work order, without changing real on-hand or the real PO.

## Phase 5 — cleanup
- `DELETE /api/quotes` gains a `?scope=test` (or a new route) → `deleteTestQuotes()`. FK CASCADE removes jobs/invoices; design artifact removed via the existing delete-design path.
- Settings `QuotesTab`: **"Delete test data (N)"** button (count of test quotes) next to "delete all".
- **Tests:** the scoped delete removes only test quotes + cascades.
- ✅ Done when: one click wipes all test quotes/jobs/invoices, real data untouched.

## Phase 6 — end-to-end verify
- Drive a full test quote on a preview: Settings → New Test Quote → build → send → portal approve → Simulate deposit paid → Jobs board (TEST) → move stages → work order → prepare (no stock change) → delete test data.
- Confirm: dashboard numbers unchanged throughout; no GHL/Valor activity; supplier PO unaffected.
- Gates green; migration applied to prod; PR for Naldo's review (Jason-area + shared data layer → heads-up).

## Risks / watch-outs
- **Find every quote read** that feeds metrics — missing one leaks test data into a number. `listQuotesForDashboard` should be the only chokepoint; verify.
- **The Valor webhook** also creates jobs on real deposits — keep `simulate-deposit` a separate, test-only path; don't entangle it.
- **`createJobFromQuote` idempotency** — the simulate route must respect the same idempotency guard (one job per quote).
- Decide join-vs-column for job `is_test` early (affects PO/prepare queries).
