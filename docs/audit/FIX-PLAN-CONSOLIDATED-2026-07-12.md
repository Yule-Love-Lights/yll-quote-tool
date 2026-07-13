# Consolidated fix plan: both 2026-07-12 audits, deduplicated

Plan only. No code changed. This reconciles the two report-only audits run 2026-07-12 so nothing gets fixed twice, then sequences the union of their findings into batched, ownership-tagged waves. Every overlap below was verified against live code by a 4-agent reconciliation pass, not symptom-matched.

## The two source reports

- **CORE (PS-, 32 findings):** deep three-persona sweep of the customer + operator core journey. `docs/audit/PERSONA-SWEEP-CORE-2026-07-12.md`, on branch `naldo/persona-sweep-core-2026-07-12`, PR #520.
- **WHOLETOOL (WT-, 65 code + 4 live WT-L, plus missed-opportunities):** wide four-persona sweep of the entire tool. `docs/audit/PERSONA-SWEEP-WHOLETOOL-2026-07-12.md`, on branch `claude/yule-lights-audit-sweep-0eea5e` (commit `b505f31`). No open PR yet.

The two reports barely overlap on findings. CORE went deep on the customer journey and the operator front-of-house; WHOLETOOL went wide across the back-office (invoices, inventory, purchase orders, GHL, analyzer, auth, settings) that CORE never entered. Net result: mostly union, one true duplicate, one shared epic.

## 1. Dedup verdicts (verified against code)

### True duplicate: fix once
- **PS-C1 = WT-L1** (event/permanent/bistro booked portal renders $0, all items OFF, blank heading, "select items to continue" on a paid quote). SAME defect. Root cause pinned: `buildApproval` in `src/lib/portal/adapter.ts:380` defaults the frozen `packageId` to the holiday-only `'C'` when the approval snapshot has no `customerSelection`, and `staff-approve/route.ts:116-125` deliberately omits `customerSelection`. Event/bistro only have `'D'`; a no-back permanent has no `'C'`, so the seed resolves to an empty selection. **Fix once, in `buildApproval`** (default to the vertical's real single package id, or have staff-approve write a minimal `customerSelection`; add a log/alert on the fallback). One important correction to bank: the prior FULL-AUDIT HIGH at `page.tsx:241` (locked portal seeds defaults not the frozen snapshot) **already shipped** (`page.tsx:289-296` now seeds from the snapshot), so do not re-touch that line. My CORE report's section-6 cross-reference to `page.tsx:241` is stale.

### Partial overlap: split, do not double-ticket
- **PS-B2 vs WT-L2.** WT-L2 bundles two different causes. Its holiday half ("Your Our Recommendation") is exactly PS-B2 (a real copy bug: package D is literally named "Our Recommendation", `derivePackages.ts:395`, and the heading prepends "Your ", `WhatsIncluded.tsx:247`). Its event half ("Your ␠") is just a downstream symptom of PS-C1 and disappears when PS-C1 ships. **Ticket only PS-B2 (copy) plus a one-line defensive `pkg?.name || 'your quote'` fallback.** Do not open a separate event-blank ticket.

### Confirmed distinct: fix both, separately (not duplicates despite similar surface)
- **PS-C3 vs WT-L3** (same color-scheme files). PS-C3 is a label-wording inconsistency ("Staff's pick" vs "As Designed" for the same null-override concept). WT-L3 is a scheme-list scoping bug (`page.tsx:341-342` positive-matches permanent only, so event/bistro inherit holiday's seasonal names Candy Cane / Christmas / Frozen). Two separate small tasks.
- **PS-C2 vs WT-03.** PS-C2 is a missing location label on itemizable spritzer rows. WT-03 is the footage-scalar-per-quote data-model limit (multi-building). Different mechanisms.
- **PS-D5 vs WT-14/WT-15.** PS-D5 is the pay-balance page UX (off-brand, amount not shown). WT-14/WT-15 are the Valor balance webhook (`valor/webhook/route.ts`) money-safety gaps. Different files, different layers.

### Shared epic: track as one initiative, keep each id as a line item
- **Commercial / multi-property:** PS-A2, PS-E5, PS-F2 + WT-03, WT-12, WT-40, WT-52, WT-53. Both reports' #1 missed opportunity, from different entry points. See section 4. WT-53 (rebook clones the wrong building) is a live bug today for any existing 2+-property customer, so it gets priority inside the epic's first slice.

## 2. Gaps my CORE sweep missed (adopt from WHOLETOOL)

The reconciliation confirmed WHOLETOOL caught seven core-journey-adjacent items my CORE sweep did not. These are now folded into the plan below:

- **WT-14 (High, money):** balance webhook has no duplicate-charge guard, unlike the deposit path. Real silent double-charge. My leg D walked the pay-balance page, never the webhook internals.
- **WT-15 (Med):** balance underpayment logs only `console.error`, no staff-visible record. Same file.
- **WT-49 (High):** inbox "Mark Handled" creates GHL opportunities in the wrong (holiday) pipeline for non-holiday contacts. In my leg E scope; PS-E1..E6 missed it.
- **WT-41 (High):** inbox list hard-caps at 100 oldest-first with no truncation indicator; newest messages vanish during a backlog. My leg E scope; missed.
- **WT-53 (High):** rebook has no property picker, clones the most-recently-approved building system-wide. I never walked the Rebook button.
- **WT-L3 / WT-L4 (Low):** event portal shows holiday palette names on a wedding quote; "Watch before you approve" CTA still shows on a booked event portal. My live walk missed both.

All 25 of my other PS findings were confirmed to have no WT counterpart (safe to fix independently).

## 3. The fix plan (union, batched, ownership-tagged, deduped)

Ownership per `AGENTS.md`: **Naldo** owns `src/app/page.tsx`, `src/components/dashboard/**`, `src/app/api/dashboard/**`, `src/lib/dashboard/**` (dashboard + inbox). **Jason** owns everything else. **Shared** files (data layer, migrations, config) need the other owner's heads-up first. An assistant never merges: every PR waits for its owner's go.

Batches below are file-collision-aware: findings that touch the same file are grouped so fixes do not clobber each other.

### Wave A: money and security ship-blockers (do first)

| PR (batch) | Findings | Owner | Files | Note |
|---|---|---|---|---|
| A1 · Event/perm/bistro booked portal $0 | PS-C1 / WT-L1 | Jason | `adapter.ts` buildApproval, `staff-approve/route.ts`, `SelectionContext.tsx` | The single dedup fix. Ship-blocker for any staff-approved non-holiday quote. |
| A2 · Balance webhook money-safety | WT-14, WT-15 | Naldo-adjacent (Jason area: integrations) | `valor/webhook/route.ts:648-738` | One PR: add txn-id compare + duplicate marker + staff alert (mirror `flagPossibleDuplicatePayment`) and a durable underpayment marker. Test-first (money). |
| A3 · Collect-payment confirm | WT-16 | Jason | `pipelineActions.ts:96`, `PipelineActionsMenu.tsx:72` | Add a confirm dialog showing the exact balance before mark-paid. |
| A4 · Cancel refund = full balance | WT-17 (+ WT-20, WT-21, WT-31 co-located) | Jason | `jobs/[id]/cancel/route.ts`, `invoices.ts` reconcile | Cancel-flow batch: refund the full collected balance, skip balance-outstanding flag on cancelled, reverse pulled stock. Test the paid-in-full cancel. |
| A5 · Stale roofline bills $0 | WT-01 | Jason | `pricingEngine.ts:454-489` | Fall through to auto/none when the explicit rooflineChoice's option is null. Money under-bill. |
| A6 · Inbox Mark-Handled wrong pipeline | WT-49 | **Naldo** | `dashboard/inbox/sync.ts:280-296` | Use `resolvePipelineStages(service_type)` or drop the opportunity-ensure step. Stops Christmas drips to non-holiday leads. |
| A7 · Print work-order auth + test badge | WT-29, WT-30 | Jason | `inventory/jobs/[id]/print/page.tsx`, `email-order/route.ts` | Add `requireOperator()` (also check the two BOM print pages) + thread `isTest` to print/email/modal. PII + phantom inventory. |
| A8 · Bistro PO "(not in catalog)" | WT-27 (coordinate with WT-22/WT-28) | Jason | `inventory/purchaseOrder.ts:188` | Backfill `nameBySku` from `BISTRO_CATALOG`. External supplier email. |
| A9 · Auth hardening | WT-60, WT-61, WT-62 | Jason | `login/page.tsx`, `OperatorNav.tsx`, `auth/logout`, `mark-device` | Logout control + clear staff-device cookie; reject `//` open redirect. Inert until AUTH_GATE flips, but land before go-live. |
| A10 · Permanent jumps training (dead loop) | WT-35 | Jason | `QuoteBuilder.tsx:1630-1700`, `permanent/trainingExamples.ts`, `permanent/fewShot.ts` | FINISH: set `analysis: data.permanentSatellite` so `seed_analysis` populates. The #140/#141 mechanism has never fired. |

### Wave B: Naldo-owned quick wins (dashboard + inbox) — implementable now

| PR (batch) | Findings | Files | Note |
|---|---|---|---|
| B1 · Dashboard $0-on-failure + caveats | WT-38 / WT-46 (same bug), WT-47, WT-48 | `page.tsx:36`, `dashboard/queries.ts`, `dashboard/metrics.ts` | Swap to `listQuotesForDashboardResult` + error banner; render the 500-cap caveat; fix the conversion sub-label to "approved / reached" and share one `reached()` helper with Insights. |
| B2 · Inbox nav badge | PS-E2 | `OperatorNav.tsx`, `page.tsx` | Overdue/open-lead badge on the Inbox nav item (data already computed). Batches cleanly with B1 (same `page.tsx`, disjoint lines). |
| B3 · Response analytics | PS-E1, WT-42 | `dashboard/inbox/ResponseAnalytics.tsx` | Stop rendering the raw operator UUID as a rep name; make the trend widget use `lastInboundAt ?? lastMessageAt` so it reconciles with the headline. |
| B4 · Inbox action row | PS-E3, PS-E4, PS-E6 | `dashboard/inbox/InboxList.tsx` | Tooltips on every action button; undo/confirm on the sticky Not-a-lead; a breakdown next to "Show N filtered". |
| B5 · Inbox store | WT-41 (needs-Naldo call), WT-43 (needs-Naldo), WT-45 | `dashboard/inbox/store.ts`, `followups.ts` | Surface "N more not shown" / paginate; re-arm follow-ups; delete the stale "NOT YET WIRED" comment. |
| B6 · Holiday card pending count | WT-39 | `dashboard/serviceMetrics.ts`, `ServiceSections.tsx` | BUILD_PARITY: add a pending (sent-not-approved) tally like the other three verticals. |
| B7 · Follow-up-days setting | WT-44 (needs-Naldo) | `inbox/settings/FollowUpDaysSetting.tsx`, `lifecycle.ts`, `followups.ts` | Rename to scope it to the stale badge, or wire the strip's cadence to it. Decide first. |

Waves A6, B1-B7 are the fixes I (this session) can own directly, since they are all in Naldo's dashboard/inbox area. Everything else is Jason's and needs his go.

### Wave C: Jason-owned front-of-house batches (portal, builder, admin, referral)

| PR (batch) | Findings | Files |
|---|---|---|
| C1 · Portal action bar | PS-D1, PS-D2, PS-D3, PS-D4, PS-D6 | `StickyBottomBar.tsx`, `portal/[quoteId]/page.tsx`, `QuoteResponseModal.tsx`, `approve/route.ts` (read `body.code`; refresh after decline; decline confirm; terms at sign; signature min-length) |
| C2 · Portal package headings + tiers | PS-B2 (+ defensive fallback), WT-05, WT-10, WT-L2 | `WhatsIncluded.tsx:247`, `InteractiveHero.tsx:431-477`, `derivePackages.ts:395`, `derivePackagesPermanent.ts` (rename package D; label permanent by surface not "Tier N"; single-package verticals) |
| C3 · Portal copy + dead data | PS-B3, PS-B4, WT-02 (REMOVE aLaCarteTotal), WT-06, WT-13 (needs-Naldo), WT-09, WT-L4 | `quoteMessages.ts:63`, `adapter.ts:112`, `derivePackages.ts`, `portal/types.ts`, `permanentBistro/*` comments |
| C4 · Permanent back-not-mapped | PS-B1 | `satelliteLines.ts`, `WhatsIncluded.tsx`, `QuoteBuilder.tsx` (warn when a billed permanent surface has no trace) |
| C5 · Color scheme labels + event palette | PS-C3 (needs-Naldo), WT-L3 | `colorSchemes.ts`, `permanentScenes.ts`, `portal/[quoteId]/page.tsx:341` |
| C6 · Spritzer label + effect scope | PS-C2, PS-C4 (needs-Naldo) | `pricingEngine.ts` (optional location label), `PermanentEffectPicker.tsx` (confirm scope) |
| C7 · Admin quotes | PS-G1, PS-G3, PS-G4 | `admin/quotes/page.tsx`, `quotes/[id]/route.ts` (delete-safety on real rows must land as one commit with the delete-error copy; consolidate the two send controls) |
| C8 · Amend dead-end + collect-payment | PS-G2, WT-16 (shared with A3) | `PipelineActionsMenu.tsx`, `admin/jobs/[id]/page.tsx` (link Record-amendment from the builder) |
| C9 · Send gate reconcile | PS-F4 | `send/route.ts:233`, `QuoteBuilder.tsx` Customer Info copy (either attach/create a HighLevel contact from manual fields, or state manual entry needs a contact to send) |
| C10 · Builder misc | PS-F1, PS-F3 (needs-Naldo) | `QuoteBuilder.tsx:2589` (drop "Testing mode" on real quotes; VIP path is a product call) |
| C11 · Referral landing | PS-A1, PS-A3, PS-A4, WT-54 | `refer/[code]/page.tsx`, `ReferralForm.tsx` (consent gate; trust above form; hero fallback; reward-copy vertical-agnostic) |

### Wave D: Jason-owned back-office batches (jobs, inventory, analyzer, GHL, settings)

| PR (batch) | Findings | Note |
|---|---|---|
| D1 · Jobs lifecycle | WT-18, WT-19 (needs-Naldo), WT-21 | Amend re-consent gate + linked-job check; scheduled-status decision. (WT-17/20/31 already in A4.) |
| D2 · Inventory correctness | WT-24, WT-25, WT-26, WT-31 | Clip-rule 0 coercion, receiveOrder dedup, materials empty-state link, prepped-cancel stock reversal. |
| D3 · Inventory dead flags (decide) | WT-22 (needs-Naldo), WT-23 (FINISH), WT-28 (needs-Naldo) | Locked-flag enforcement scope; wire hide-category filter; manual PO line. |
| D4 · Analyzer | WT-32, WT-33 (FINISH), WT-34, WT-36, WT-37 | Garland-size enum; surface degraded few-shot signal; back-link copy; dropped-jumps note; permanent corrections editor. |
| D5 · GHL | WT-50 (needs-Naldo), WT-51 | Landscape pipeline points at the live bistro pipeline; Settings/HighLevel page shows the per-vertical map. (WT-49 in A6, Naldo.) |
| D6 · Settings parity | WT-11 (BUILD), WT-57, WT-58, WT-56/WT-65/WT-07 (needs-Naldo), WT-63 (needs-Naldo), WT-64 (needs-Naldo) | Permanent FAQ warranty (cheap build) + stale comments; warranty-editable and holiday-rates-editable and bistro-maintenance are business calls (section 5). |

## 4. Commercial / multi-property epic (the #1 missed opportunity, both reports)

**Current state: half-built.** A `customers` + `properties` schema (one customer to many properties) already exists and is populated on every quote (`customers.ts:37-46,289-344`); quotes carry `customer_id` and `property_id`. But almost nothing reads it: `getPropertiesForCustomer` has zero non-test callers (WT-52); Rebook is already property-aware on the backend (`rebook.ts:118`, the route parses `propertyId`) but `RebookButton.tsx:22` sends no body, so it clones the wrong building (WT-53); the portal adapter already maps `content.customer.address` but no component renders it pre-approval (WT-12); worklist/needsAction already select `quote_number` but render only the name (WT-40). **Greenfield:** no account/organization entity above the person-level customer; footage is one scalar per quote (`pricingEngine.ts:188-217`); no commercial pricing or net terms; the leads `company` field is a spam honeypot, not a business field.

**Correction to bank:** WT-52's "data already fetched" is wrong for the customer page. `DASHBOARD_QUOTES_SELECT` (`queries.ts:23-39`) omits `customer_address`, so Phase 1 must add that column.

**Phase 1 (first slice, no migration): surface what already exists.** Add `customer_address` to `DASHBOARD_QUOTES_SELECT` and `DashboardQuote`; add an Address column to the customer-detail quote history and group by property using the currently-dead `getPropertiesForCustomer` (its first real caller); render quote_number + service badge + address in worklist/needsAction subtitles; show the property address above the fold on the portal; wire `RebookButton` to fetch properties and POST `{ propertyId }` with a picker/confirm when there is more than one. **Closes WT-52, WT-40, WT-12, and the live WT-53 bug with zero schema change.** Ownership straddles: the rebook/worklist/dashboard pieces are Naldo's, the customer-detail page and portal hero are Jason's, so split into two coordinated PRs.

**Phases 2-5 (greenfield, needs-Naldo scoping):** account/organization entity (Phase 2, SHARED migration); per-property or grouped-quote model resolving the footage-scalar wall (Phase 3, product decision: grouped quotes vs true multi-building-per-quote); commercial lead front door + account rollup (Phase 4); commercial pricing + net-30/PO terms (Phase 5, money-code, test-first). Phases 2-5 are a real initiative, not a patch, and should be scoped with you before any build.

## 5. Decisions I need from you before building (needs-Naldo)

These are product/business calls, not defects. Grouped so you can answer in one pass.

- **Holiday rates editable? (WT-63)** Build a HolidayRatesSettings panel like the other three verticals, or keep holiday rates deploy-only as a safety brake on the money-critical vertical?
- **Warranty copy editable for holiday/event/bistro? (WT-56/65/07)** Extend permanent's editable+versioned+frozen mechanism to the other three, or keep them code-only (warranty changes rarely)?
- **Bistro maintenance plan? (WT-64)** Sell a recurring annual maintenance plan on bistro jobs like permanent, or not?
- **Package taglines on the portal? (WT-13)** Render the hand-authored taglines, or drop the dead field?
- **Scheduled job stage (WT-19):** track scheduling + install date in this tool (build the write path), or accept that scheduling lives in home.works and remove the empty Scheduled bucket + Install column?
- **Locked-SKU enforcement (WT-22):** when a SKU is marked sold out, should it hard-block quoting, just warn, or only block the auto-PO?
- **Manual PO line (WT-28):** add a manual "add a line" to the PO builder for low-stock SKUs with no active-job demand, or label the low-stock alert informational-only?
- **Follow-up cadence (WT-44):** should the follow-up strip's 3-day cadence be operator-tunable, or is the setting only meant for the stale badge?
- **Inbox 100-cap (WT-41):** paginate/count vs a hard cap for the shared queue.
- **Color labels + event palette (PS-C3, WT-L3):** "Staff's pick" vs "As Designed" wording; and should event get its own palette instead of holiday's Candy Cane/Christmas/Frozen?
- **Confirm-intent items from CORE (PS-C4 effect-picker scope, PS-D3 decline confirm, PS-D4 terms at sign, PS-D6 signature minimum, PS-A1 referral consent, PS-C2 spritzer labels, PS-A4 hero fallback).**
- **The commercial epic Phases 2-5 scope.**

## 6. What I recommend doing first

1. **Wave A money/security** (A1-A10): these are the ones that move real money wrong or expose PII. A2 (balance double-charge), A4 (cancel refund), A5 (roofline $0), A1 (booked $0 portal), A7 (print auth) are the sharpest.
2. **Wave B** (my dashboard/inbox area): I can start these immediately on your go. B1 (dashboard $0-on-failure) is the one that most distorts what you see day to day.
3. **Commercial Phase 1**: cheap, high-value, closes a live bug (WT-53), no migration.

Nothing here is built yet. Say which wave to start (and give the go per PR, since `master` auto-deploys). Jason-area PRs need his review; the dashboard/inbox waves are mine to run once you approve.
