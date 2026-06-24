# Phase 2b — Builder service-type radio (#58)

> **Status:** built on `naldo/dashboard-service-type-builder-form` (off master). **Jason-review PR**
> (touches the shared data layer + Jason-area builder/route). Gates green: tsc · lint 0/2 · 277 tests.

## Goal
Let staff tag a quote's service line (Holiday / Permanent / Event) in the builder so the dashboard's
per-service sections (Phase 2a) populate with real Permanent/Event data instead of everything reading
Holiday. Phase 2a shipped the column + dashboard reads; this is the **write** path.

## What changed
| File | Change | Owner |
|---|---|---|
| `src/lib/serviceType.ts` (new) | Canonical `ServiceType` + `SERVICE_TYPES` + labels + `DEFAULT_SERVICE_TYPE` + `asServiceType()` guard. Dependency-free (client+server safe). | new / shared |
| `src/lib/serviceType.test.ts` (new) | Unit tests for the guard + constants. | — |
| `src/lib/quoteForm.ts` | `QuoteFormData.serviceType`; `initialFormData` default holiday; `inputsToFormData` 3rd arg (rides the column, not pricing inputs). | shared-ish (Naldo touched, tested) |
| `src/lib/quoteForm.test.ts` | Round-trip updated; serviceType hydration test. | — |
| `src/lib/quotes.ts` | `saveQuote`/`updateQuote` accept serviceType; `getQuoteRaw`/`QuoteRaw` carry it. | **SHARED — Jason review** |
| `src/app/api/quote/route.ts` | Validate `body.serviceType` (400 if bad); default holiday on create, untouched on update when absent. | **Jason area** |
| `src/components/quote/QuoteBuilder.tsx` | Service-type radio under customer fields; `serviceType` in both POST bodies; `QuoteBuilderInitial` + hydration. | **Jason area** |
| `src/app/quote/[id]/page.tsx` | Pass `quote.service_type` into the builder. | **Jason area** |

## Decisions
- **serviceType is NOT a pricing input.** It rides the `quotes.service_type` column, never the `inputs` jsonb. So `buildQuoteInputs` is unchanged and `inputsToFormData` takes it as a separate arg.
- **Update semantics:** `updateQuote` only writes `service_type` when provided — a re-price that omits it can't reset the column. The builder always sends it, so editing re-asserts the form's value (hydrated from the stored one → round-trips).
- **Default holiday** everywhere a value is absent (new quote, legacy NULL row), matching the migration backfill.

## Dependencies / merge order
1. **`service_type` column must exist.** Added by Phase 2a's migration (`migrations/2026-06-24-quotes-service-type.sql`), **already applied to the live Supabase**. This branch is off master and does NOT carry that migration file. **Merge order: Phase 1 → Phase 2a → Phase 2b** (or 2a + 2b together). The column being live means dev/prod run regardless of merge order; the only gap is a from-scratch `FULL-SCHEMA.sql` rebuild between a 2b-merge and a 2a-merge (not a real scenario for this team).
2. **ServiceType dedupe (follow-up):** the dashboard (`src/lib/dashboard/types.ts`, Phase 2a) defines its own identical `ServiceType`. Once both are on master, point it at `src/lib/serviceType.ts` to remove the duplicate. Noted in a comment in `serviceType.ts`.

## Verification
- ✅ tsc clean · lint 0 errors (2 baseline) · 277 tests (serviceType + quoteForm round-trip + hydration).
- ✅ Live: `/quote/new` renders the radio (radiogroup + 3 options); invalid `serviceType` → HTTP 400.
- ✅ Grepped every caller of `saveQuote`/`updateQuote`/`inputsToFormData`/`getQuoteRaw`/`QuoteBuilderInitial` — no missed sites (the other `getQuoteRaw` consumer, `trainingExamples.ts`, is additive-safe).
- ⏳ **Left for a real-quote check (Naldo/Jason):** create a Permanent/Event quote → confirm the row's `service_type` persists and the dashboard's Permanent/Event sections move. (A prod DB write was intentionally not performed in the build session.)
