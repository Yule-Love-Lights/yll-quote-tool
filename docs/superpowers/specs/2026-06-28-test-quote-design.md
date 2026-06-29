# Test Quote — fully-simulated end-to-end test data (#93)

**Status:** SPEC — build-ready, design approved by Naldo (2026-06-28). To be built in a fresh session.
**Owner:** Jason's area (quote builder · portal · pricing-adjacent · dashboard) + the SHARED data layer (`quotes.ts`, `jobs.ts`, `invoices.ts`) — Naldo is directing it. Coordinate the data-layer touches.
**Migration:** yes (one `is_test` column on `quotes`). No pricing-engine change.

## The ask (Naldo)
> "Make an option in Settings to create a **test quote** that goes through ALL the steps of customer quote creation → being made into a Job → going through inventory — the same exact thing as 'Make New Quote' but a **New Test Quote**, so we no longer mess up our real data testing things."

## Locked decisions (don't re-ask)
1. **Fully safe / simulated** — a test quote NEVER fires a real text, email, or card charge. Each real-world side effect is suppressed; the deposit gate is a one-click **"Simulate deposit paid"** that runs the *same* downstream (`createJobFromQuote`) so the Job appears and flows into inventory.
2. **`is_test` boolean column on `quotes`** (default `false`), **propagated to the Job and Invoice** created from it.
3. **Entry in Settings** — a "Make New Test Quote" button (the existing hidden **Quotes tab** in `/settings` is the home). Opens the same builder at `/quote/new?test=1`; a persistent **TEST MODE** banner while building/driving it.
4. **Real screens, simulated side-effects** — you click through the actual builder + portal (Approve is real); only the *external* effects (GHL messaging, Valor charge, staff emails) are suppressed. The "Simulate deposit paid" lives on the **portal pay button** for test quotes.
5. **Badged + metrics-excluded, but visible** — test quotes/jobs show a **TEST** badge in the admin quotes list, jobs board, and inventory, and are **excluded from all dashboard metrics + the customer list + the worklist**. They stay visible so you can drive them.
6. **Cleanup** — a **"Delete test data"** button in Settings (Quotes tab) wipes every `is_test` quote; FK `ON DELETE CASCADE` (already on `jobs.quote_id` / `invoices.quote_id`) removes the job/invoice; the design artifact goes with it.

## Architecture

### A. Data — the flag
- Migration `migrations/2026-06-28-quotes-add-is-test.sql`: `ALTER TABLE quotes ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;` + `CREATE INDEX IF NOT EXISTS quotes_is_test_idx ON quotes (is_test);` (idempotent, per CONVENTIONS §6; model: `migrations/2026-06-24-quotes-service-type.sql`).
- **No new column on `jobs`/`invoices`** — derive `is_test` by joining back to the quote (a job/invoice always has a `quote_id`). Simpler + can't drift. (Alternative if a join is awkward in a hot path: denormalize an `is_test` column onto `jobs`; decide at build.)
- `src/lib/quotes.ts`: `saveQuote()` accepts + writes `is_test`; `listQuotes()` selects it (for the badge). `updateQuote()` leaves it untouched.

### B. Entry + builder
- `src/app/settings/page.tsx` → **Quotes tab** (`QuotesTab`): add a "Make New Test Quote" button → `Link`/navigate to `/quote/new?test=1`. Also add the "Delete test data" button here (next to the existing "delete all").
- `src/components/quote/QuoteBuilder.tsx` (+ `/quote/new` page): read `?test=1` → carry an `isTest` flag into the save path (`saveQuote`/`POST /api/quote`) so the created row is `is_test=true`. Render a persistent **TEST MODE** banner when `isTest`.

### C. Simulate the flow (suppress real side-effects when `is_test`)
- **Send** — `src/app/api/quotes/[id]/send/route.ts`: when the quote `is_test`, **skip** the GHL SMS/email + the GHL stage-sync; still stamp `quote_sent_at` so the UI advances. (Log "simulated send" instead.)
- **Approve** — `src/app/api/quotes/[id]/approve/route.ts`: when `is_test`, **skip** the staff-notify email; still write the approval snapshot.
- **Pay → Job** — for a test quote the portal's deposit button calls a NEW **`POST /api/quotes/[id]/simulate-deposit`** (operator/test only): stamps `deposit_paid_at` (+ a synthetic payment marker) and calls the SAME `createJobFromQuote` the Valor webhook uses. No Valor, no charge. The portal (`DepositCheckout` / pay flow) renders **"Simulate deposit paid"** instead of the Valor redirect when the quote `is_test`.
- `src/lib/jobs.ts` `createJobFromQuote()` — carry `is_test` onto the Job (via the quote link / column per A).

### D. Isolation — exclude test from real data
- **Dashboard + customers + worklist** — the dashboard reads through `src/lib/dashboard/queries.ts` `listQuotesForDashboard()`. Add `WHERE is_test = false` THERE (single chokepoint → metrics, customers page, worklist, workflow board, insights, serviceMetrics all exclude test in one place). Verify `customers.ts` / `dashboard/customers.ts` also route through it; if any read quotes directly, add the filter.
- **Admin quotes list** (`/admin/quotes` via `listQuotes`) — keep test rows VISIBLE; add a **TEST** badge column/pill.
- **Portal loader** (`src/lib/portal/loader.ts`) — test quotes still load (so you can drive the portal). No change beyond the simulate-pay branch.

### E. Inventory safety (the subtle part — a test Job must not touch real stock/orders)
A test Job SHOULD appear in the fulfillment Kanban + work order (so you exercise inventory), but its stock-affecting operations must be inert:
- **Supplier PO** — `src/lib/inventory/purchaseOrder.ts` `buildSupplierPurchaseOrder()`: **exclude `is_test` jobs** (else a test job's material needs get ordered from the real supplier).
- **Stock decrement on prepare** — `src/lib/inventory/jobs.ts` `prepareJobMaterials()` (the "Mark prepared — deduct stock"): for a test job, **do NOT decrement real `inventory_on_hand`** — no-op the deduction (still advance the stage / mark prepped so the UI flows). 
- **Fulfillment board / work order** (`/inventory/jobs`): test jobs VISIBLE + TEST-badged.

### F. Cleanup
- NEW `deleteTestQuotes()` in `quotes.ts` (`DELETE FROM quotes WHERE is_test = true`) + a route (extend `DELETE /api/quotes` with a `?scope=test` or a new endpoint). FK CASCADE removes jobs/invoices; the design artifact is removed by the existing "delete a quote → delete its design" path.
- Settings Quotes tab: "Delete test data (N)" button next to "delete all".

## Touchpoint map (build checklist)
| Area | File | Change |
|---|---|---|
| Migration | `migrations/2026-06-28-quotes-add-is-test.sql` | add `is_test` + index |
| Data | `src/lib/quotes.ts` | `saveQuote` writes `is_test`; `listQuotes` selects it; new `deleteTestQuotes()` |
| Data | `src/lib/jobs.ts` | `createJobFromQuote` carries `is_test` (join or column) |
| Data | `src/lib/invoices.ts` | invoice inherits `is_test` (join) |
| Entry | `src/app/settings/page.tsx` (`QuotesTab`) | "Make New Test Quote" + "Delete test data" buttons |
| Builder | `src/components/quote/QuoteBuilder.tsx`, `/quote/new` | read `?test=1`, TEST banner, save as `is_test` |
| Send | `src/app/api/quotes/[id]/send/route.ts` | skip GHL when `is_test` |
| Approve | `src/app/api/quotes/[id]/approve/route.ts` | skip staff email when `is_test` |
| Pay→Job | NEW `src/app/api/quotes/[id]/simulate-deposit/route.ts` + portal pay UI | simulate deposit-paid → `createJobFromQuote` |
| Metrics | `src/lib/dashboard/queries.ts` (+ verify `customers.ts`) | exclude `is_test` |
| Admin list | `/admin/quotes` | TEST badge |
| Inventory PO | `src/lib/inventory/purchaseOrder.ts` | exclude `is_test` jobs |
| Inventory prep | `src/lib/inventory/jobs.ts` (`prepareJobMaterials`) | no real stock decrement for test jobs |
| Inventory board | `/inventory/jobs` | TEST badge |
| Cleanup | `DELETE /api/quotes` (scope=test) | wipe test quotes |
| Auth | new `simulate-deposit` route + the cleanup | operator-gated (`getOperator`, dormant `AUTH_GATE_ENABLED`) |

## Out of scope (YAGNI)
- Real/sandbox Valor payments; a separate test database/environment; test data for anything beyond the quote→job→inventory pipeline; auto-generating quote *content* (you build it in the real builder).

## Testing
- Pure: `saveQuote`/`createJobFromQuote` carry `is_test`; `deleteTestQuotes` scopes correctly; `buildSupplierPurchaseOrder` excludes test jobs; `prepareJobMaterials` no-ops stock for a test job.
- Dashboard: `listQuotesForDashboard` excludes `is_test` (a test quote never appears in metrics/customers).
- Route: `simulate-deposit` creates a Job + is operator-gated; send/approve skip externals when `is_test`.
- Gates: `npx tsc --noEmit` · `npm run lint` · `npm test`. Apply the migration to prod (Supabase MCP `apply_migration` or the SQL editor) before merge.

## Notes for the builder
- Master moves fast (multi-dev). Branch off FRESH master, re-ground the exact lines (the #81 auth + #82 inventory landed recently), and TDD. The `getOperator()` dormant pattern (`if (process.env.AUTH_GATE_ENABLED==='true' && !(await getOperator())) redirect/401`) is the gate for new operator routes/pages.
