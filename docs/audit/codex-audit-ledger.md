# Codex Audit Ledger

## FINDINGS

- CODX-F-001 | 2026-07-18 | Low | confirmed | src/lib/pricing/pricingEngine.ts:900 | Binary floating-point rounds some exact half-cent tax amounts down by one cent.
- CODX-F-002 | 2026-07-18 | Medium | confirmed | src/app/api/quotes/[id]/approve/route.ts:180 | The public approval endpoint accepts a missing e-signature and records signature null.
- CODX-F-003 | 2026-07-18 | High | confirmed | src/app/api/quotes/[id]/amend/route.ts:231 | A changed booked order requires re-consent, but the customer portal has no re-consent path.
- CODX-F-004 | 2026-07-18 | Low | confirmed | src/components/quote/QuoteBuilder.tsx:2688 | Customer information labels are not programmatically associated with their inputs.
- CODX-F-005 | 2026-07-18 | Medium | confirmed | src/app/api/quotes/[id]/send/route.ts:491 | The send API and builder report success when every requested customer message fails.
- CODX-F-006 | 2026-07-18 | Medium | confirmed | src/app/api/quotes/[id]/send/route.ts:262 | A zero-line-item quote can be stamped sent even though its customer portal only renders the finalized placeholder.
- CODX-R-001 | 2026-07-18 | Low | refuted | src/lib/invoices.ts:468 | Proportional tax scaling for a partial selection is exact while one flat tax rate applies to every taxable item.
- CODX-R-002 | 2026-07-18 | Low | refuted | src/lib/pdf/docModels.ts:286 | The quote PDF using the original approval total is intentional as the signed snapshot; current amendment presentation is covered by CODX-F-003.
- CODX-R-003 | 2026-07-18 | Low | refuted | src/lib/portal/derivePackages.ts:178 | The order minimum is intentionally checked before discounts so a promotion cannot make an otherwise eligible order unapprovable.
- CODX-R-004 | 2026-07-18 | High | refuted | src/lib/integrations/valor.ts:345 | The current Valor parser recognizes the live `data.invoice_no` order reference; the older webhook diagnostic comment describing dropped hosted-page deposits is stale.

## SUGGESTIONS

- CODX-S-001 | 2026-07-18 | proposed | Add a customer amendment comparison and re-sign screen | amendments and customer portal.
- CODX-S-002 | 2026-07-18 | proposed | Show separate SMS and email delivery receipts with retry actions | quote sending.
- CODX-S-003 | 2026-07-18 | proposed | Give the customer a durable approval receipt with signer, selection, and money details | approval and trust.
- CODX-S-004 | 2026-07-18 | proposed | Add a run-scoped QA console that lists and cleans up only one audit run's test quotes | QA safety.
- CODX-S-005 | 2026-07-18 | proposed | Add a guided first-quote walkthrough for new operators | operator onboarding.
