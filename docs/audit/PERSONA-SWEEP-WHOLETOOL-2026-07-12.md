# Whole-Tool Persona Sweep: AI Quote Tool (2026-07-12)

Wide, systematic, report-only audit of the ENTIRE tool through four persona lenses, run as a
21-area multi-agent workflow (Sonnet finders + adversarial verify, Opus completeness critic)
plus a live in-browser walk of all four vertical portals. Findings only: no code changed, no
feature branch, no merge. This sweep prioritizes BREADTH and CROSS-AREA CONSISTENCY; a separate
session runs a narrow deep sweep of just the core journey, so the two reports are meant to be
diffed. Where breadth forced code-reading over live-driving (the auth-gated operator side), the
coverage map says so plainly.

**Personas:** P1 luxury homeowner · P2 commercial / multi-property buyer · P3 first-day operator
· P4 owner / power-user.

**Method:** every finding was traced to real `file:line` and adversarially verify-checked (real?
reachable? intentional? already-known?). 66 candidate findings → 65 confirmed, 1 refuted (an
"event has no order minimum" claim, refuted because event inherits the holiday $1,000 gate). The
4 live portal findings below the code set were caught by driving the seeded prod portals.

## Executive summary

**Confirmed severity counts:** 0 Critical · 23 High · 26 Med · 16 Low (65 code findings), plus
4 live-portal UX findings and a missed-opportunities section. No new Criticals: the one prior
CRITICAL (event front-footage double-bill) is already filed and was not re-litigated here.

### Top fixes (highest impact first)

1. **Balance-payment webhook has no double-charge guard, but the deposit path does** (`src/app/api/integrations/valor/webhook/route.ts:652-738`). A customer who completes the balance hosted-payment page twice is charged twice with zero durable record and zero staff alert. The deposit path already has exactly this guard (`flagPossibleDuplicatePayment`); the balance path was never given it. **Money, silent.**
2. **"Collect payment" one-click marks an invoice fully paid with no confirm and no amount shown** (`src/lib/pipeline/pipelineActions.ts:96` + `PipelineActionsMenu.tsx:72`). Every other money action confirms first. A misclick, or an operator who took only a partial cash payment, zeroes the entire remaining balance with no way to tell afterward that money is still owed. **Money, owner.**
3. **Cancel-refund alert only ever quotes the DEPOSIT, even when the full balance was already collected** (`src/app/api/jobs/[id]/cancel/route.ts:111-156`). If a paid-in-full order is cancelled, the staff refund email and the stored `refundDue` under-state the true refund owed by the entire collected balance. **Money, customer-facing refund.**
4. **A stale roofline choice silently drops the whole roofline line to $0** (`src/lib/pricing/pricingEngine.ts:454-489`). Pick "Gingerbread", then later zero its footage: the engine bills $0 for roofline even though real Santa's footage is sitting right there, with no error or visual cue. **Money, under-bill.**
5. **Inbox "Mark Handled" creates GHL opportunities in the wrong (holiday) pipeline for non-holiday contacts** (`src/lib/dashboard/inbox/sync.ts:280-296`). It reads legacy single-pipeline env vars instead of `resolvePipelineStages(service_type)` like every other call site, so a permanent/event/bistro lead gets a duplicate card in Christmas Lights and can trip a Christmas drip.
6. **Every bistro auto-PO emails the real supplier line items named "(not in catalog)"** (`src/lib/inventory/purchaseOrder.ts:188`). Bistro SKUs live in a static catalog with no DB rows; `buildSupplierPurchaseOrder` resolves names from the DB table only, so pooled bistro lines fall to the "(not in catalog)" fallback in the actual Thunder order email. A sibling function already fixed this; the PO builder never got the fix. **External-facing, live vertical.**
7. **The printable work-order page has zero auth and AUTH_GATE will never close it** (`src/app/inventory/jobs/[id]/print/page.tsx:17-21`). A server component that renders full customer name, address, install date, and pick list for any job UUID with no `requireOperator()`. Unlike the rest of the operator app, flipping the gate on at go-live does not fix this. **PII exposure.**
8. **The owner's main daily dashboard silently renders $0 on a read failure** (`src/app/page.tsx:36`). Home uses the error-swallowing `listQuotesForDashboard`; Insights uses the Result-aware variant with an error banner. On any Supabase blip the whole home page reads as a real quiet day: $0 KPIs, empty pipeline, "All caught up."
9. **The permanent AI training loop's jump ground-truth is permanently empty** (`QuoteBuilder.tsx:1630-1700` + `src/lib/permanent/trainingExamples.ts:222`). `design.seed_analysis` is never populated for permanent quotes, so every few-shot example teaches `"jumps": []`. The #140/#141 "teach the AI to detect jumps" mechanism has never once fired since it shipped.
10. **The multi-property data model is dead in the UI, and one-click Rebook clones the wrong building** (`src/lib/customers.ts:452-465`, `RebookButton.tsx:22`). The backend supports one customer to many properties, but nothing reads it: a commercial buyer shows as one undifferentiated row, and Rebook silently clones whichever address was approved most recently system-wide.

### Top missed opportunities (led by the commercial gap)

1. **There is no commercial / multi-property data model at all.** The schema is customer → one quote → one address. A P2 buyer with several buildings has no home in this tool: no way to group properties under one account, roll them into one invoice or one PO, apply portfolio pricing, or give one portal login visibility across sites. Every one of the 21 finders audited strictly inside the single-house assumption because that is all the data model allows. This is the single biggest structural gap and it directly blocks a stated target market.
2. **Holiday, the highest-volume vertical today, is the least configurable.** Permanent, event, and bistro each got a Settings-editable rate table; holiday's rates, fees, tax, deposit %, and minimum are hardcoded constants. The owner can retune the three newer verticals without a deploy but not the one that pays the bills.
3. **The design editor and its projection math are money-bearing and were not adversarially audited.** The design IS the master item list and projects to billed line items, yet no finder verified projection math, reopen/rehydrate semantics, or yardstick-scale drift. A bug here drifts customer prices exactly like a pricing-engine bug.
4. **The lead-to-quote front door leaks conversions.** Website "landscape" leads silently return "deferred" with no pipeline card because they depend on never-wired env vars, even though the same Landscape pipeline is now live under bistro.

## Coverage map

Every area enumerated below was opened. Status key: **Walked** = driven live in the browser ·
**Read** = code-grounded (files read/traced, `file:line` cited) · **Sampled** = partially examined,
noted where · **Skipped** = not opened (none).

### Customer-facing

| Area | Status | Evidence |
|---|---|---|
| Holiday portal (seeded quote) | Walked + Read | Live: `/portal/9f7e62e2…` · code: `portal/[quoteId]/page.tsx`, adapter, snowglobe+dark components |
| Event portal (booked seeded) | Walked + Read | Live: `/portal/b4dad6bc…` (booked fixture, not touched) |
| Permanent portal (seeded) | Walked + Read | Live: `/portal/85163f9e…` |
| Bistro portal (seeded) | Walked + Read | Live: `/portal/0249447a…` |
| Holiday pricing engine | Read | `pricingEngine.ts`, `derivePackages.ts`, `agreedTotal.ts`, `money.ts` |
| Event pricing + packages | Read | `event/pricing.ts`, `event/packages.ts`, `event/rates` |
| Permanent pricing + packages | Read | `permanent/pricing.ts`, `derivePackagesPermanent.ts` |
| Bistro pricing + packages | Read | `permanentBistro/{pricing,packages,types}.ts` |
| Approve → deposit → balance | Read | approve/pay/pay-balance/send-balance routes, Valor webhook, `balanceCollection.ts` |
| Referral / refer landing | Read | `refer/[code]/page.tsx`, `referrals.ts`, `/api/referrals/*` |

### Back-office (operator side is auth-gated; code-read, not live-driven — see note)

| Area | Status | Evidence |
|---|---|---|
| Invoices / amend / refund | Read | `invoices.ts`, `amend.ts`, `/admin/invoices`, charge-balance, mark-paid |
| Jobs lifecycle | Read | `jobs.ts`, `jobStatus.ts`, convert/complete/close/cancel routes |
| Inventory stock + materials | Read | `inventory/{onHand,materials,catalog,bindings,resolveInstalls}.ts` |
| Purchase orders + reorder | Read | `purchaseOrder.ts`, `lowStock.ts`, auto-send, Thunder/Ascend/Bistro catalogs |
| Inventory jobs + prepare | Read | `inventory/jobs.ts`, prepare + email-order routes, print work-order page |
| Holiday analyzer + training | Read | `photoAnalysis.ts`, `fewShot.ts`, `/training/*`, references |
| Permanent analyzer + training | Read | `permanent/{photoAnalysis,satelliteMeasure,orientation,trackAccessories,fewShot}.ts` |
| Dashboard home + worklist | Read | `page.tsx`, `dashboard/{serviceMetrics,worklist,needsAction,queries}.ts`, ServiceSections |
| Inbox / customer dashboard | Read | `/inbox/*`, `dashboard/inbox/*` (classify/escalation/followups/lifecycle/reply/metrics) |
| Insights / analytics | Read | `/insights`, `dashboard/{insights,metrics,serviceMetrics,referralMetrics}.ts`, posthog |
| GHL pipeline sync | Read | `highlevel*.ts`, `ghlPipelineMap.ts`, ghl webhook/reconcile, settings/highlevel |
| Customers + rebook | Read | `customers.ts`, `/customers/*`, rebook |
| Settings (all tabs) | Read | `appSettings.ts`, `/settings/*`, all `components/settings/*` |
| Auth / operator gate / accounts | Read | `auth/*`, `proxy.ts`, login, mark-device, admin/users |
| Cross-vertical consistency | Read | dedicated diff of all four verticals across pricing/portal/analyzer/settings/dashboard/BOM |

### Under-examined (disclosed gaps — NOT "clean")

The completeness critic flagged five surfaces that no finder owned. They are called out here so
none reads as "audited and clean":

- **Design editor / editor-core** (`components/design/*`, ~26 `editor-core/*.ts`): the largest
  audit-dark surface, and money-bearing (drawn geometry → billed line items). No finder owned it.
- **Quote Builder operator UI as a whole** (`components/quote/QuoteBuilder.tsx`): referenced by ~8
  finders only as a cross-reference; the a-la-carte edit and reopen-a-saved-quote flows had no
  dedicated lens.
- **Lead intake front door** (`lib/leads/leadService.ts` + public lead capture): only seen from
  inside GHL, never as its own conversion/dedup surface.
- **Deposit checkout + payment UI** (`DepositCheckout.tsx`, `QuoteResponseModal.tsx`,
  `StickyBottomBar.tsx`): grepped, not read end to end.
- **Premium-visual / responsive / accessibility rendering**: a static code audit cannot see price
  legibility or premium feel. The live portal walk below is a partial substitute for the customer
  side only; the operator side got no visual pass.

**Note on the operator side:** the in-app browser is not signed into the auth-gated operator
console, and `AUTH_GATE_ENABLED` is off pre-go-live, so back-office surfaces were code-grounded
rather than live-driven. Every back-office finding cites `file:line` and was verify-checked. If
you want any specific operator screen driven live, say which and I will walk it in the logged-in
Chrome.

---

## Findings by area

Row format: **id · [severity] · persona · verdict** — title · Where · What's wrong · Fix ·
Needs-Naldo flag. All verdicts are from the adversarial verify pass unless marked LIVE.

### Holiday pricing

**WT-01 · [High] · P4 · CONFIRMED — Stale roofline choice silently drops the entire roofline line to $0**
- Where: `src/lib/pricing/pricingEngine.ts:454-489` (`resolveRooflineChoice`/`rooflineLineItem`) + `quoteForm.ts:211,233` + `QuoteBuilder.tsx:2305-2308`.
- Wrong: `resolveRooflineChoice` trusts `inputs.rooflineChoice` verbatim, and `rooflineLineItem` only emits when the chosen option still exists. `form.rooflineChoice` is set once by `recommendRoofline` and never cleared when footage later changes. Enter Santa's 100ft + Gingerbread 40ft, pick "Gingerbread" ($1,400 billed), then correct Gingerbread footage to 0 and Calculate: `options.gingerbread` is now null, the choice is still "gingerbread", both branches fail, roofline bills $0 while 100ft of Santa's footage is ignored. No error, no visual cue.
- Fix: In `resolveRooflineChoice`, if the explicit choice's option is null, fall through to `autoRooflineChoice` (or 'none') instead of returning the stale choice.
- Needs Naldo: no.

**WT-02 · [Low] · P4 · CONFIRMED — Package C `aLaCarteTotal` is computed, wired, tested, and rendered nowhere ("you save $X" is invisible)**
- Where: `src/lib/portal/derivePackages.ts:307-341`; `components/portal/types.ts:19`.
- Wrong: `aLaCarteTotal` is carried onto every Package C and unit-tested, but no portal component reads it, and per its own test it is currently identical to Package C's total (would always show $0 savings). Plumbing for a bundle-discount feature finished on neither end.
- Fix: Either render it once a real bundle discount exists, or drop the field + tests and note it as deferred.
- Needs Naldo: no.

**WT-03 · [Med] · P2 · CONFIRMED — Footage products are one scalar per quote, so a multi-building order cannot be itemized**
- Where: `src/lib/pricing/pricingEngine.ts:188-217` (`santasFootage`/`gingerbreadFootage`/`winterWonderlandFootage`/`stakeLightingFootage` are each a single `number`).
- Wrong: Per-unit items scale to many buildings (they carry stable ids); every footage-based product is one number for the whole quote. A commercial buyer with 3 buildings must either blend footage into one number (losing per-building price transparency) or open separate quotes (losing the one-relationship experience).
- Fix: Architectural, not a patch. If multi-property is active, tag roofline-family inputs per building. Flagged for awareness.
- Needs Naldo: yes.

### Event pricing + packages

**WT-04 · [Low] · P4 · CONFIRMED — `calculateEventQuote` has no test for a flat discount or an over-subtotal discount, yet referral credits (flat) reach event quotes**
- Where: `src/lib/event/pricing.ts:329-338`; tests at `event/pricing.test.ts`.
- Wrong: The only discount test uses percentage. The flat branch and the `Math.max(0,…)` clamp are untested for event, but the referral credit banner sets `discountType:'flat'` and is gated only on `linkedCustomerId && savedQuoteId` (not on service type), so an event customer can drive the untested flat path with real money.
- Fix: Add flat-discount and over-subtotal-clamp cases to `event/pricing.test.ts`.
- Needs Naldo: no.

### Permanent pricing + packages

**WT-05 · [High] · P1 · CONFIRMED — Package B is named "Both Sides" / "Front & Sides" even when only ONE side is actually included**
- Where: `src/lib/permanent/derivePackagesPermanent.ts:79-93`.
- Wrong: `sideIds` is whichever of left/right/legacy ids have a line item; it is not required to contain both. A one-side-only home (townhome, corner lot) still gets the package named "Both Sides" with tagline "Left + right sides." That name renders to the customer (`InteractiveHero.tsx:464`, `WhatsIncluded.tsx:247`). A customer can be shown a package described as covering both sides when only one side is billed and installed.
- Fix: Derive the name/tagline from which side ids are actually present ("Left Side" / "Right Side" for one, "Both Sides" only when both exist). Copy call.
- Needs Naldo: yes (wording).

**WT-06 · [Med] · P4 · CONFIRMED — rush/takedown defense-in-depth zeroing covers event + bistro but omits plain permanent**
- Where: `src/lib/portal/derivePackages.ts:82-97` (`noHolidayFees = isEvent || isPermanentBistro`, never `isPermanent`).
- Wrong: The documented "defense in depth against a stray/forged toggle" zeroing of `charges.rush/takedown` is skipped for permanent. Masked today (server force-zeroes for permanent at `approve/route.ts:383-388`, and the UI hides the toggle behind a positive `isHoliday` check), but if that UI gate ever regresses a permanent portal could display a phantom $150 rush/takedown the server never charges: a portal-vs-invoice mismatch. A passing bistro test exists; no permanent equivalent.
- Fix: Add `!!result.permanentRatesSnapshot` to `noHolidayFees`, plus a parallel test.
- Needs Naldo: no.

### Bistro (permanent_bistro) vertical

**WT-07 · [Med] · P4 · CONFIRMED — Bistro warranty copy is hardcoded, not Settings-editable, and never frozen into the approval snapshot (unlike permanent's identical feature)**
- Where: `components/portal/dark/RiskReversal.tsx:32-37` (`BISTRO_GUARANTEES`) vs `RiskReversalPermanent.tsx` + `PermanentWarrantySettings.tsx` + `portal/[quoteId]/page.tsx:411-418`.
- Wrong: Permanent's warranty is Settings-editable, versioned, and frozen on approval so a later edit never changes what an approved customer sees. Bistro's near-identical warranty promise is a bare hardcoded array with no settings hook, no version, no freeze.
- Fix: Fold bistro into the permanent-warranty settings/freeze mechanism, or document it as intentionally static code-only copy.
- Needs Naldo: yes.

**WT-08 · [Low] · P4 · CONFIRMED — Bistro is the only satellite-drawing vertical with zero AI auto-trace**
- Where: `QuoteBuilder.tsx:1701-1757` ("there is no auto-trace for bistro").
- Wrong: Permanent seeds AI-detected geometry before the operator draws; bistro (built on the same satellite UI) starts every quote from a blank draw. Deliberate v1 simplification, but a real capability gap between the two most similar verticals.
- Fix: Optional. Port the permanent auto-trace seed to bistro if volume grows.
- Needs Naldo: no.

**WT-09 · [Low] · P3 · CONFIRMED — Stale "PENDING wiring" comments in the bistro engines understate that bistro is fully live**
- Where: `src/lib/permanentBistro/pricing.ts:1-2`, `packages.ts:1`.
- Wrong: Both headers say "PENDING wiring", but bistro is dispatched live (`api/quote/route.ts:547`, `adapter.ts:533`) end to end. A dev or operator reading cold would wrongly conclude bistro isn't live.
- Fix: Delete/update the "PENDING wiring" phrase. Doc-only.
- Needs Naldo: no.

### Portal (cross-vertical render)

**WT-10 · [Med] · P1 · CONFIRMED — Single-package verticals show a lone tile mislabeled "Tier 1" in a 2-column grid; permanent's surface packages are mislabeled as tiers**
- Where: `components/portal/snowglobe/InteractiveHero.tsx:431-477` (esp. 456).
- Wrong: The eyebrow is `Tier ${i+1}` for non-holiday. Event and bistro return exactly one package, so the customer sees a single "TIER 1" tile alone in a `grid-cols-2` group with a dead second cell (reads as broken). Permanent's four packages are house SURFACES (Front / Front & Sides / Back / Whole Home), not price tiers, so "Back of Home = Tier 3" implies a pricier upgrade of "Front of Home".
- Fix: Single-package verticals: hide the eyebrow or use the package name; consider single-column when `packages.length === 1`. Permanent: label by surface, not ordinal tier.
- Needs Naldo: yes.

**WT-11 · [Med] · P4 · CONFIRMED — Permanent warranty can silently diverge between the Risk-Reversal section and the FAQ answer on the same page**
- Where: `components/portal/mockQuote.ts:360-361` (permanent FAQ warranty, hardcoded) vs `RiskReversalPermanent.tsx` (Settings-editable, versioned, frozen).
- Wrong: The whole point of the permanent warranty feature is Settings-editable copy. But the FAQ "What is the warranty?" answer is a hardcoded string with no wiring. Edit the warranty in Settings and the two sections on one page say different things.
- Fix: Derive the FAQ answer from the same settings, or make it generic ("see Your Protection above").
- Needs Naldo: yes.

**WT-12 · [Med] · P2 · CONFIRMED — No property address or site identifier appears anywhere on the pre-approval portal, any vertical**
- Where: `portal/[quoteId]/page.tsx:305-495` and every portal component; the only `.address` usage is on the post-approval `/approved` page.
- Wrong: The hero greets by first name only. A commercial buyer receiving several portal links (one per building) has nothing but the photo to tell which property a link is for until after approval.
- Fix: Surface the address or a short site label above the fold pre-approval, all verticals.
- Needs Naldo: yes.

**WT-13 · [Low] · P4 · CONFIRMED — Every derived package across all four verticals carries a `tagline` that is never rendered**
- Where: `components/portal/types.ts:15` (required field) populated in every derive fn; consumed nowhere.
- Wrong: Hand-authored, shipped marketing copy that no portal component ever reads. Dead data across all four verticals.
- Fix: Render it (one-line subhead) or drop it from the type + derivations.
- Needs Naldo: yes.

### Approve → deposit → balance

**WT-14 · [High] · P4 · CONFIRMED — Balance webhook has no duplicate-charge detection; the deposit path does**
- Where: `src/app/api/integrations/valor/webhook/route.ts:652-738` (`handleBalancePayment`) vs `flagPossibleDuplicatePayment` at 81-129.
- Wrong: The deposit path flags a second webhook with a new txn id and emails staff. `handleBalancePayment` has no equivalent: on already-paid it returns silently with no compare against `valor_balance_txn_id` and no alert. A customer who completes the balance page twice is charged twice with no durable record and no staff alert.
- Fix: Before the "already paid" and lost-race returns, compare `event.txnId` against `invoice.valor_balance_txn_id` and write a duplicate marker + staff alert on mismatch, mirroring the deposit path.
- Needs Naldo: no.

**WT-15 · [Med] · P4 · CONFIRMED — Balance underpayment logs only `console.error`, no staff-visible record**
- Where: `valor/webhook/route.ts:688-699`.
- Wrong: A short balance payment (>1c under) logs to console and returns `underpaid:true`; the invoice stays unpaid and nothing durable surfaces in the app. Real money moved with no dashboard-visible marker.
- Fix: Write a durable shortfall marker on the invoice (or a staff alert) so it surfaces on the operator invoice view.
- Needs Naldo: no.

### Invoices / amend / refund

**WT-16 · [High] · P4 · CONFIRMED — "Collect payment" one-click marks an invoice fully paid with no confirm and no amount shown**
- Where: `src/lib/pipeline/pipelineActions.ts:96` + `components/admin/PipelineActionsMenu.tsx:72-73`.
- Wrong: 'close' and 'cancel' confirm first; 'collect-payment' does not. It POSTs `mark-paid`, which unconditionally sets `status='paid', balance=0` (no amount parameter). The label is a static "Collect payment" with no dollar figure. A misclick or a partial-cash collection zeroes the entire balance silently.
- Fix: Add a `window.confirm` showing the exact balance, or route through the invoice detail page (which already gates + shows the amount).
- Needs Naldo: no.

**WT-17 · [High] · P4 · CONFIRMED — Cancel-refund alert only quotes the deposit even when the invoice was paid in full**
- Where: `src/app/api/jobs/[id]/cancel/route.ts:111-156`.
- Wrong: `refundedInvoice` (true when status='paid') is computed but never feeds the amount. The refund record and staff email are gated on `refundedDeposit` and use `deposit_amount_usd` only. A paid-in-full order that gets cancelled under-reports the true refund owed by the entire collected balance; only the JSON `refundedInvoice:true` flag hints at it, and nothing quantifies it. The full-paid case is untested.
- Fix: When `refundedInvoice`, compute the refund from `invoice.total` and update the email/snapshot wording for a full-order refund.
- Needs Naldo: no.

**WT-18 · [Med] · P4 · CONFIRMED — Re-consent after a price-increasing amendment is advisory only; nothing blocks settling before the customer re-approves**
- Where: `amend/route.ts:216-220` + `src/lib/amend.ts:184-208` (`requiresReconsent`/`amendedQuoteStatus` never gate anything; `amendedQuoteStatus` is dead).
- Wrong: An amend-up reopens the invoice to awaiting_payment, which immediately becomes eligible for the unconfirmed one-click "Collect payment" (WT-16) or Close, with zero verification the customer agreed to the increase. The code's own comment marks this an undecided spec question.
- Fix: Gate mark-paid/charge-balance/close on the last amendment's `requiresReconsent`, or require an explicit re-approved timestamp.
- Needs Naldo: yes (spec §9 undecided).

### Jobs lifecycle

**WT-19 · [High] · P4 · CONFIRMED — The `scheduled` job status and `install_date` are permanently dead; a whole pipeline stage never fires**
- Where: `src/lib/jobStatus.ts:13,34` (transition allowed, no writer); rendered live in `WorkflowBoard.tsx:172-174`, `admin/jobs/page.tsx`, `JobStatusBadge.tsx`, `inventory/jobs/page.tsx:150`; `jobs.ts:31` `install_date` never written.
- Wrong: The documented lifecycle is to_schedule → scheduled → installed → requires_invoicing → done, and every UI surface renders a live "Scheduled" bucket and an Install date. No code path ever writes `scheduled` or `install_date`; jobs jump straight to installed. So the Scheduled filter is always empty and the Install column is always "—". A shipped half-feature (scheduling was meant to sync from home.works, never wired back).
- Fix: Build the write path (an operator Schedule action or a home.works webhook), or remove the dead status/filter/column and the `install_date` field from these surfaces.
- Needs Naldo: yes.

**WT-20 · [Med] · P4 · CONFIRMED — `reconcileInvoice` flags a cancelled order's dead invoice as "balance outstanding" / "short-deposit"**
- Where: `src/lib/invoices.ts:157-172`; rendered at `admin/jobs/[id]/page.tsx:279-307`.
- Wrong: `setInvoiceStatus` never zeroes balance, so a cancelled invoice keeps its nonzero balance. `reconcileInvoice` pushes 'balance-outstanding' for any non-paid status including cancelled, showing a red "Reconciliation issues" banner on a dead order. The only real action on a cancel is a refund, not collection. Untested for cancelled.
- Fix: Skip balance-outstanding/short-deposit when `status==='cancelled'`, or add a distinct "cancelled — refund may be owed" flag.
- Needs Naldo: no.

**WT-21 · [Low] · P4 · CONFIRMED — Amend gates on the quote's own status but never the linked job's status**
- Where: `amend/route.ts:107-134` vs `cancel/route.ts:88-93` (quote-status write is best-effort).
- Wrong: Cancel writes the job first, then best-effort writes the quote status. If that write fails, the quote can read "booked" while its job is "cancelled", and amend (which checks only the quote) still records a financial amendment against a dead order.
- Fix: Have amend also read the linked job and 409 if `job.status === 'cancelled'`.
- Needs Naldo: no.

### Inventory stock + materials

**WT-22 · [High] · P4 · CONFIRMED — The sold-out "locked" flag is cosmetic everywhere except the Overrides page itself**
- Where: `inventory/overrides/page.tsx:5` (promises the engine won't order locked items); `SkuPicker.tsx:107-163` (badge only); `resolveInstalls.ts:52-59`; `purchaseOrder.ts:149-186`; `materialsProjection.ts:275-300`.
- Wrong: `locked` is read only by the catalog and a display badge. It is never consulted by the SKU picker's selection, the customer-facing "which colors can we supply" gate, or the auto-PO / materials view. Marking a SKU sold out does not stop quoting with it, does not flag unfulfillable, and does not stop the supplier PO from ordering it: exactly the three things the page's own copy claims.
- Fix: Thread `locked` through `offeredFromBindings`, `buildSupplierPurchaseOrder`/`aggregateMaterials`, and the SkuPicker confirm.
- Needs Naldo: yes.

**WT-23 · [High] · P4 · CONFIRMED — The "Hide category" setting has zero consumers anywhere in the app**
- Where: `inventory/catalog.ts:104-119` (own comment: the materials engine "must compute the same effective category to honor hides"); `skuSearch.ts` (no filter); `overrides/page.tsx`.
- Wrong: `hiddenCategories` is written and read back only to re-render its own toggle. `searchCatalog` and the materials engine never filter on it. Fully functional plumbing around a setting nothing reads.
- Fix: Wire it into `searchCatalog` + the materials engine, or remove the dead setting/UI.
- Needs Naldo: no.

**WT-24 · [Med] · P4 · CONFIRMED — Clip rule "0 clips/ft" is silently coerced back to the 1/ft default**
- Where: `src/lib/inventory/clipRules.ts:32-34`; `bindings/page.tsx:265-273` (`min={0}` invites 0).
- Wrong: `perFt = perFtRaw > 0 ? perFtRaw : DEFAULT_CLIP_PER_FT`, so an explicit stored 0 fails `>0` and becomes 1/ft. An operator who deliberately zeroes a feature's clip rate still gets clips ordered at 1/ft on every roofline run using it, in both the materials view and the pooled PO.
- Fix: Distinguish "unset" from "explicitly 0" (`typeof rule?.perFt === 'number'`).
- Needs Naldo: no.

**WT-25 · [Low] · P4 · CONFIRMED — `receiveOrder`'s manual override doesn't dedupe SKUs, so a duplicated body line double-counts stock**
- Where: `src/lib/inventory/orders.ts:146-166`.
- Wrong: Validation checks membership via Sets (which a duplicate trivially satisfies) but never collapses duplicates; the receive loop calls `adjustOnHandAtomic` once per array entry, so a repeated SKU adds its qty twice. Not reachable via the shipped UI (object-keyed by SKU); reachable via any direct API call.
- Fix: Collapse `receivedLines` by SKU before applying, or reject duplicate SKUs.
- Needs Naldo: no.

**WT-26 · [Low] · P3 · CONFIRMED — The Materials page covers only holiday/event scene projection; permanent quotes hit a bare "no design" with no pointer to the real BOM**
- Where: `inventory/materials/page.tsx:74-128`; permanent BOM actually lives inline on `admin/quotes/[id]/page.tsx:232-253`.
- Wrong: A permanent quote on the Materials page shows "This quote has no design" with no hint the BOM is on the quote detail page. Bistro gets its own `/inventory/bistro` tab; permanent gets no `/inventory` entry at all.
- Fix: For permanent/bistro service types, replace the empty state with a link to that quote's BOM page.
- Needs Naldo: no.

### Purchase orders + reorder

**WT-27 · [High] · P4 · CONFIRMED — Bistro Thunder lines ship on the real supplier PO email as "(not in catalog)"**
- Where: `src/lib/inventory/purchaseOrder.ts:188` (vs the fix already in `jobs.ts:264-272`).
- Wrong: Bistro SKUs live in a static catalog with no `inventory_catalog` rows. `buildSupplierPurchaseOrder` resolves names from `listCatalog()` (DB only), so every pooled bistro line falls to the `?? '(not in catalog)'` fallback in the email actually sent to the Thunder contact. A sibling function already backfills from `BISTRO_CATALOG`; the PO builder never got it.
- Fix: Backfill `nameBySku` from `BISTRO_CATALOG` in `buildSupplierPurchaseOrder` (only if not already present).
- Needs Naldo: no.

**WT-28 · [Med] · P4 · CONFIRMED — Low-stock alarm and the demand-driven PO are disconnected; no in-app way to order a low-stock SKU with no active-job demand**
- Where: `src/lib/inventory/lowStock.ts:10-15` vs `purchaseOrder.ts:149-186` + `inventory/orders/page.tsx`.
- Wrong: Low-stock flags on `on_hand ≤ reorder_point`, independent of jobs; the PO is demand-only and never reads `reorder_point`; the orders page has no manual add-line. So a shop-supply SKU that trips the alert but isn't on any active job can never be put on a supplier order in-app.
- Fix: Add a manual "add a line" control to the PO builder, or label the low-stock alert as informational-only.
- Needs Naldo: yes.

### Inventory jobs + prepare

**WT-29 · [High] · P4 · CONFIRMED — The printable work-order page has zero auth check, and AUTH_GATE will never close it**
- Where: `src/app/inventory/jobs/[id]/print/page.tsx:17-21`.
- Wrong: A server component that calls `getJobWorkOrder(id)` with no `requireOperator()`, and there is no middleware or `/inventory` layout gate. It renders full customer name, address, install date, and pick list for any job UUID. Unlike the rest of the operator app, flipping `AUTH_GATE_ENABLED` on does not fix this. Same pattern likely on the two BOM print pages.
- Fix: Add `requireOperator()` at the top of the page (and check `admin/quotes/[id]/bom/print` and `bistro-bom/print`).
- Needs Naldo: no.

**WT-30 · [High] · P4 · CONFIRMED — The test-quote badge exists only on the Kanban card; the print sheet, emailed order, and work-order modal show a test job as a real one**
- Where: `inventory/jobs/[id]/print/page.tsx`; `email-order/route.ts:34-47`; `jobs/page.tsx:21-24`.
- Wrong: `prepareJobMaterials` correctly no-ops the on-hand deduction for a test job, and the Kanban shows a Test badge, but `isTest` never reaches the modal, print page, or emailed order. Staff can pull real materials for a test job, and because on-hand is deliberately not decremented for test jobs, that physical pull creates a silent, untraceable inventory shortfall.
- Fix: Thread `isTest` to all three surfaces (badge on modal, "TEST — do not pull real stock" banner on print, subject/body prefix on the email).
- Needs Naldo: no.

**WT-31 · [Med] · P4 · CONFIRMED — Cancelling a prepped job never returns the deducted stock, and the job vanishes from every fulfillment view**
- Where: `src/app/api/jobs/[id]/cancel/route.ts` (no stock reversal); `inventory/jobs.ts:32-34` (`isActiveFulfillment` excludes cancelled).
- Wrong: A prepped job (stock decremented) that is later cancelled has no logic to add the units back, and once cancelled it drops off the Jobs Kanban entirely, so nothing tells staff "these materials were pulled but never installed." On-hand is silently understated with no trace back to the cancelled job.
- Fix: In cancel, check `stock_decremented_at`; auto-reverse the deduction or surface a "return N × SKU to stock" note.
- Needs Naldo: no.

### Holiday analyzer + training

**WT-32 · [High] · P4 · CONFIRMED — The Product Reference Library garland-size dropdown offers a non-existent length and omits the real one**
- Where: `training/references/page.tsx:11` (`GARLAND_SIZES = ['9ft','6ft']`) vs canonical `GARLAND_LENGTHS = ['4.5ft','9ft']`; POST validated against the canonical set at `api/references/route.ts:28-31`.
- Wrong: This page hardcodes its own list instead of importing the shared enum. '6ft' does not exist anywhere else, so picking it always fails validation with "Invalid size for garland", and 4.5ft (a real supported type) can never be uploaded through this UI at all.
- Fix: Import `GARLAND_LENGTHS` (as `training/examples` already does) and drop '6ft'.
- Needs Naldo: no.

**WT-33 · [Med] · P4 · CONFIRMED — The "similarity retrieval degraded to recency" warning is computed but never reaches any UI**
- Where: `src/lib/fewShot.ts:185-193` (`degraded` flag) vs `analyzeWithFewShot.ts:12-17` (type narrows to `{ranking}`) and `QuoteBuilder.tsx:1471-1565` (reads only `.ranking`).
- Wrong: `degraded` is meant to distinguish a real Voyage outage from the benign small-library recency fallback, but the type and the only UI consumer drop it. Staff see an identical "recent" badge for both cases, so the one signal built to catch a silent quality degradation never surfaces.
- Fix: Widen the types to carry `degraded` and show a distinct warning badge, or remove the unused computation.
- Needs Naldo: no.

**WT-34 · [Low] · P3 · CONFIRMED — The Training Examples back link names a page that doesn't exist under that name**
- Where: `training/examples/page.tsx:169` ("← Training Houses") vs `training/page.tsx:51` (h1 "AI Training Database").
- Wrong: The link reads "Training Houses" but the destination is titled "AI Training Database" everywhere in its own UI. "Training Houses" matches only the DB table name.
- Fix: Rename the link to match the destination title; optionally add a one-line note on how the two training corpora relate.
- Needs Naldo: no.

### Permanent analyzer + training

**WT-35 · [High] · P4 · CONFIRMED — The permanent training loop's jump ground-truth is permanently empty**
- Where: `QuoteBuilder.tsx:1630-1700` (permanent branch never sets `analysis`) + `permanent/trainingExamples.ts:222` (`original_analysis: design.seed_analysis ?? null`) + `permanent/fewShot.ts:70`.
- Wrong: The permanent analyzer's raw result is read into component state but never pushed to `analysis-context`, unlike holiday. So `design.seed_analysis` stays null for every permanent design forever; captured examples store `original_analysis: null`; every few-shot example teaches `"jumps": []`. The #140/#141 jump-detection training has never fired since it shipped. Operator-visible too: every permanent example's provenance reads "No AI run — fully manual design" though all went through the analyzer.
- Fix: In the permanent branch of `handleLookupAddress`, set `analysis: data.permanentSatellite` alongside the satellite fields, mirroring the holiday path.
- Needs Naldo: no.

**WT-36 · [Med] · P4 · CONFIRMED — AI-detected jump distances beyond 200ft are silently dropped with no operator signal**
- Where: `src/lib/permanent/photoAnalysis.ts:117,149` (`MAX_JUMP_FT = 200`).
- Wrong: A jump over 200ft is dropped as a hallucination guard with no trace (no note, no count). On a large estate or a detached-but-included structure with a real bridge over 200ft, the Extensions/Splitters card silently comes up short: a quiet BOM under-count only a material shortfall would later reveal.
- Fix: Append dropped jumps to the returned `notes` or a `droppedJumps` count so the operator can add the connection manually.
- Needs Naldo: no.

**WT-37 · [Low] · P4 · CONFIRMED — The permanent training-examples review has no corrections editor; a bad AI trace can only be excluded/deleted, not fixed**
- Where: `components/training/PermanentExamplesTab.tsx:1-6` ("v1-minimal: no corrections editor (that's v2)").
- Wrong: Holiday's training tab lets staff inline-edit footage/difficulty and PATCH the correction; permanent's tab is read-only apart from Exclude/Delete, so a mis-traced side or wrong jump loses the otherwise-usable photos/geometry entirely. Deliberately scoped v1, but a real cross-vertical gap.
- Fix: Add a corrections editor mirroring the holiday tab (PATCH to `/api/permanent-training-examples/[id]`).
- Needs Naldo: no.

### Dashboard home + worklist

**WT-38 · [High] · P4 · CONFIRMED — The dashboard home uses the error-swallowing quotes accessor, not the Result-aware one built to fix exactly this**
- Where: `src/app/page.tsx:36` (`listQuotesForDashboard`) vs `dashboard/queries.ts:49-83` (`listQuotesForDashboardResult`).
- Wrong: The plain accessor swallows a Supabase read failure into `[]`; the doc comment says correctness-caring callers should use the Result variant and show an error banner. Only Insights does. So on any read failure the home page renders fully-populated-looking but empty: $0 KPIs, "Inbox zero", "All caught up", empty pipeline, "No bookings yet" — indistinguishable from a real quiet day. Only a server-side `console.error` fires. (Also filed from the insights lens; same root, same fix.)
- Fix: Swap `page.tsx` to `listQuotesForDashboardResult(500)` and render the Insights error-banner pattern on `ok:false`.
- Needs Naldo: no.

**WT-39 · [Med] · P4 · CONFIRMED — Holiday's service-line card is the only one with no pipeline/pending visibility**
- Where: `dashboard/serviceMetrics.ts:48-84` (`computeHolidayBreakdown`) vs 86-140 (permanent/event/bistro all track `pending`).
- Wrong: Permanent, event, and bistro cards surface a "Pending" (sent, not yet approved) count. Holiday, today's core business, tracks only booked/installed/goal and never reads `quote_sent_at`, so its card gives zero at-a-glance signal of holiday quotes sitting sent-and-waiting.
- Fix: Add a `pending` count to `HolidayBreakdown` and surface it in `HolidaySection` for parity.
- Needs Naldo: no.

**WT-40 · [Med] · P2 · CONFIRMED — Worklist and Needs-Action rows carry only a customer name; multi-quote/multi-property rows are indistinguishable**
- Where: `dashboard/worklist.ts:19-63`, `needsAction.ts:79-189`, `types.ts:70-77`.
- Wrong: `quote_number` is already selected but never read; every row's title is just the customer name, with no quote number, address, dollar total, or service badge. A commercial contact with several quotes (or a residential customer with a holiday + permanent quote in flight) produces rows reading as identical text differing only by age.
- Fix: Add `quote_number` (and ideally service type) to the row subtitle.
- Needs Naldo: no.

### Inbox / customer dashboard

**WT-41 · [High] · P2 · CONFIRMED — The main inbox list hard-caps at 100 items, oldest-first, with no truncation indicator; the newest messages vanish during a backlog**
- Where: `src/lib/dashboard/inbox/store.ts:372-384` (`listOpenItems`, default limit 100, ascending); called with no override at `inbox/page.tsx:19`.
- Wrong: The list orders oldest-first and hard-limits to 100 with no pagination and no "showing 100 of N" warning (unlike the metrics list, which surfaces `truncated`). Above 100 open items (holiday backlog, or the commercial scale this tool targets), the newest customer messages are silently excluded from both the list and the "Open leads" count. Escalation email alerts still fire correctly (that path has no limit), so it is purely a UI-visibility gap, but a severe one for a shared queue.
- Fix: Add a count query (or surface `N more not shown`) / paginate, mirroring the analytics `truncated` pattern.
- Needs Naldo: yes.

**WT-42 · [High] · P4 · CONFIRMED — The Response-time Trend widget still measures from the pre-#110-fix timestamp, so it disagrees with the headline metric on the same page**
- Where: `dashboard/inbox/responseMetrics.ts:164-176` (`medianResponseIn`) vs 96-105 (`computeResponseMetrics`), both in `ResponseAnalytics.tsx:114-120`.
- Wrong: #110 W7-003 fixed the headline metric to measure from `last_inbound_at` (because `last_message_at` gets overwritten by our own outbound reply on auto-resolve). `computeTrend`'s helper still reads `lastMessageAt` with no fallback, so the trend arrow can say "faster" purely because more replies were sent outside the inbox that week, while the correct headline number right above it is unchanged. Two numbers on one screen that don't reconcile.
- Fix: `medianResponseIn` should use `i.lastInboundAt ?? i.lastMessageAt`, the same fallback the headline uses.
- Needs Naldo: no.

**WT-43 · [Med] · P4 · CONFIRMED — "Done" on a follow-up permanently retires it; no re-arm if the quote is still unapproved weeks later**
- Where: `dashboard/inbox/store.ts:651-731` (`ensureFollowUp` unique on (item, reason) any status; `markFollowUpDone` just flips to done).
- Wrong: A quotetool inbox item's id is stable for the quote's life, so clicking Done once permanently closes the "sent, no reply" nudge. The reconcile cron will never recreate it, even weeks later while still unapproved. The only backstop is the operator remembering.
- Fix: Re-arm after N more days, or scope the idempotency check to `status='pending'`.
- Needs Naldo: yes.

**WT-44 · [Med] · P4 · CONFIRMED — The "Follow-up reminder (days)" setting doesn't control the feature it's named after**
- Where: `inbox/settings/FollowUpDaysSetting.tsx:44-48` vs `lifecycle.ts:17-20` (its only consumer) vs `followups.ts:37-53` (hardcoded `afterDays=3`).
- Wrong: The one operator-configurable inbox setting reads as if it governs the "due today" follow-up strip. It only changes the unrelated "Xd quiet" stale badge threshold. The follow-up strip's cadence comes from a hardcoded `afterDays=3` the setting never touches.
- Fix: Rename the setting to scope it to the stale badge, or wire the strip's `afterDays` to it.
- Needs Naldo: yes.

**WT-45 · [Low] · P3 · CONFIRMED — Stale "NOT YET WIRED" comment contradicts the live, fully-wired follow-up feature**
- Where: `dashboard/inbox/followups.ts:5-9`.
- Wrong: The header says the follow-up helpers exist "but nothing creates follow-ups yet and the /inbox UI has no due-today strip." False today: sync creates them, the strip renders, the Done route exists.
- Fix: Delete/update the stale comment.
- Needs Naldo: no.

### Insights / analytics

**WT-46 · [High] · P4 · CONFIRMED — Home dashboard money KPIs silently render zero on a query failure (same root as WT-38, insights lens)**
- Where: `src/app/page.tsx:36`; `queries.ts:9-13,80-83`; contrast `insights/page.tsx:26-55`.
- Wrong: The homepage's Booked lifetime, Booked 30-day, Conversion, ServiceSections, and ReferralMetricsCard numbers all render $0/—/0 on a read failure with no indication anything broke, while Insights one click away shows a red "Couldn't load insights" banner for the identical failure.
- Fix: Same as WT-38.
- Needs Naldo: no.

**WT-47 · [High] · P4 · CONFIRMED — The 500-row "capped" flag is computed to warn about truncated lifetime totals but is never surfaced**
- Where: `queries.ts:15-21,67-69` (`capped` computed) vs `insights/page.tsx:26,57` (drops it) and `page.tsx:36` (wrapper discards it).
- Wrong: `capped = rows.length === limit` exists so the caller can show a "based on newest 500 quotes" caveat, but no caller reads it. Once total non-test quotes across all verticals exceed 500, every "lifetime" number on the dashboard and Insights silently starts excluding the oldest bookings with no caveat and no way for anyone to know the totals stopped being complete.
- Fix: Render a "based on the newest 500 quotes" caveat when `result.capped` is true.
- Needs Naldo: no.

**WT-48 · [Med] · P4 · CONFIRMED — Homepage "Conversion" and Insights "Close ratio" compute the same ratio differently, and the homepage sub-label is wrong**
- Where: `dashboard/metrics.ts:62` (no terminal check on the reached line) vs `insights.ts:85-86` (terminal-aware); labels `KpiStrip.tsx:31` ("approved / sent") vs `insights/page.tsx:80` ("approved / reached").
- Wrong: A quote approved offline then cancelled is counted toward the homepage's Conversion denominator but excluded from the Insights Close-ratio denominator, so the same quotes yield two different percentages for what reads as one metric. Separately, the homepage sub-label "approved / sent" is wrong regardless: the real formula is "approved / reached", exactly as Insights labels it. Neither edge case is tested.
- Fix: Share one `reached()` helper across both files, and fix the homepage sub-label to "approved / reached".
- Needs Naldo: no.

### GHL pipeline sync

**WT-49 · [High] · P4 · CONFIRMED — Inbox "Mark Handled" creates GHL opportunities in the wrong (holiday) pipeline for non-holiday contacts**
- Where: `src/lib/dashboard/inbox/sync.ts:280-296` (`runHandledWriteback`).
- Wrong: Every quote-facing GHL call resolves the pipeline via `resolvePipelineStages(quote.service_type)`. The Handled write-back instead reads legacy `HIGHLEVEL_PIPELINE_ID` / `HIGHLEVEL_STAGE_QUOTE_CREATED` directly, and `HandledTarget` carries no service type. So marking a permanent/event/bistro conversation Handled finds no card in Christmas Lights and CREATES a duplicate opportunity there, invisible on the correct vertical's board and able to trigger a Christmas drip at a non-holiday customer.
- Fix: Drop the opportunity-ensure step from the Handled write-back, or thread service type through `HandledTarget` and use `resolvePipelineStages`.
- Needs Naldo: yes.

**WT-50 · [Med] · P4 · CONFIRMED — Website "landscape" leads still depend on never-wired env vars though the same GHL pipeline is now live under bistro**
- Where: `src/lib/leads/leadService.ts:34-65` (`resolveLeadPipeline` case 'landscape') vs `ghlPipelineMap.ts:63-77` (permanent_bistro rides the live Landscape Lighting pipeline).
- Wrong: Landscape resolves purely from `HIGHLEVEL_PIPELINE_ID_LANDSCAPE` / `HIGHLEVEL_STAGE_LANDSCAPE_ENTRY`, which appear only in `leadService.ts` and its tests, never in any env doc or the Settings page: no evidence they were ever configured. So a website landscape lead gets a contact created but no pipeline card, ever (silently "deferred"), even though the exact Landscape pipeline is live and already moving bistro cards.
- Fix: Point `resolveLeadPipeline('landscape')` at `resolvePipelineStages('permanent_bistro', { envOverrides:false })` and retire the dead env vars.
- Needs Naldo: yes.

**WT-51 · [Med] · P4 · CONFIRMED — The Settings → HighLevel page documents only legacy holiday env vars, hiding the whole per-vertical pipeline map**
- Where: `src/app/settings/highlevel/page.tsx:19-25`.
- Wrong: The only operator-facing GHL setup page lists 5 legacy holiday env vars and nothing about the hardcoded per-vertical ids in `ghlPipelineMap.ts`, the per-type quote-link fields, the landscape vars, or the SMS/email-from vars. It renders the live pipeline list but never cross-checks the hardcoded map against it, so if a pipeline/stage is renamed in GHL (which happened once for bistro) cards silently stop moving with no on-page diagnostic.
- Fix: List each service type's map entry next to the live pipeline it names and flag any id no longer present in `listPipelines()`.
- Needs Naldo: no.

### Customers + referrals

**WT-52 · [High] · P2 · CONFIRMED — The multi-property data model exists in the backend but is completely dead in the UI**
- Where: `src/lib/customers.ts:452-465` (`getPropertiesForCustomer` has zero non-test callers); `customers/[contactId]/page.tsx:183-213` (quote-history table has no address column).
- Wrong: The schema supports one customer to many properties (a `properties` table is populated on every quote), but nothing reads it. The customer list and detail page aggregate by identity only; a commercial buyer with 3 addresses shows as one row with one total, and the quote-history table doesn't even display each quote's address.
- Fix: Add an address column to the quote-history table (data already fetched), and group history by property when there is more than one.
- Needs Naldo: no.

**WT-53 · [High] · P2 · CONFIRMED — "Rebook last season" has no property picker; it clones whichever property was approved most recently system-wide**
- Where: `components/dashboard/RebookButton.tsx:22` (POSTs no body); `src/lib/rebook.ts:113-146` (route accepts an optional `propertyId` the UI never sends).
- Wrong: The route already accepts `propertyId` to disambiguate, but the only UI never offers or sends it. For a 2+ property customer, the query picks whichever address was approved most recently and clones that design into a new draft with no confirmation of which address. One click can silently start a season's draft for the wrong building.
- Fix: Add a property picker to RebookButton when there is more than one property, or show the source address in a confirm step.
- Needs Naldo: no.

**WT-54 · [Med] · P1 · CONFIRMED — The referral landing promises "2 free spritzers" to everyone, but the reward can only ever be fulfilled on holiday/event**
- Where: `refer/[code]/page.tsx:137-143` + `ReferralForm.tsx:60-63` (unconditional promise) vs `QuoteBuilder.tsx:2623-2629` (spritzer banner gated to holiday/event, by design).
- Wrong: The public landing and confirmation screen make the spritzer reward look universal, but the builder can only add it on holiday/event. A friend who books permanent or bistro was promised something the tool cannot give, and the landing never hints the reward differs by service.
- Fix: Define an equivalent reward for permanent/bistro, or make the landing copy vertical-agnostic ("a thank-you gift on your first booked install").
- Needs Naldo: yes.

**WT-55 · [Low] · P4 · CONFIRMED — No operator UI to merge two already-diverged duplicate customer rows**
- Where: `customers/*`, `api/customers/route.ts` (no merge affordance; the inbox DuplicatesList is a separate feature for touches).
- Wrong: Dedup happens only automatically at write time. Two rows for the same person with no overlapping identity field (legacy pre-match-key row, or a name typo with no email/phone) can never be manually merged.
- Fix: Backlog item: an admin action to re-point quotes/referrals/properties at one row and delete the loser.
- Needs Naldo: no.

### Settings

**WT-56 · [Med] · P4 · CONFIRMED — Only permanent has an operator-editable protection/warranty card; holiday, event, and bistro are hardcoded**
- Where: `components/portal/dark/RiskReversal.tsx:11-37` (GUARANTEES / EVENT_GUARANTEES / BISTRO_GUARANTEES hardcoded) vs `PermanentWarrantySettings.tsx`.
- Wrong: Permanent got full CRUD over its "Your Protection" card, server-versioned and frozen on approval. The same section for the other three verticals is a hardcoded array literal with no Settings surface. Naldo can retune permanent's guarantee wording any time but not the other three.
- Fix: Extend the Settings-editable pattern to holiday/event/bistro, or document that they are intentionally code-only.
- Needs Naldo: yes.

**WT-57 · [Low] · P4 · CONFIRMED — Stale comment in `PermanentRatesSettings.tsx` references a deleted feature flag**
- Where: `components/settings/PermanentRatesSettings.tsx:5-6`.
- Wrong: The header mentions "the feature flag that turns the Permanent option on", but `permanentEnabled` was fully removed (S23). Dead documentation.
- Fix: Delete the "plus the feature flag…" clause.
- Needs Naldo: no.

**WT-58 · [Low] · P4 · CONFIRMED — SettingsSubNav still labels the Customer Portal tab a "placeholder/stub" after it shipped**
- Where: `components/dashboard/SettingsSubNav.tsx:8` vs `settings/customer-portal/page.tsx`.
- Wrong: The nav comment says "Placeholder for now… (stub page)", but the page is fully built (early-install-discount toggle wired into the approve route + the swatch editor). A "coming soon that already shipped" comment that will mislead the next dev.
- Fix: Update/remove the stale comment.
- Needs Naldo: no.

**WT-59 · [Low] · P4 · REFUTED-AS-STATED, kept as narrower Low — event has no independently-tunable job minimum (it inherits holiday's hardcoded $1,000)**
- Where: `adapter.ts:548-557` / `approve/route.ts:508-523`; `event/types.ts` has no `minimum` field.
- Wrong (corrected): The original claim "event has no minimum gate at all" is FALSE: event inherits the $1,000 holiday gate (verified live: the event portal shows "Our minimum is $1,000"). The real, narrower point is that event, unlike permanent ($2,500, editable) and bistro (editable, gate-off capable), has no OWN Settings-editable minimum. The code comment calls the shared $1,000 deliberate, so this is likely intentional.
- Fix: Confirm event should keep sharing holiday's $1,000, or add an `EventRates.minimum`. Likely a no-op.
- Needs Naldo: yes (confirm intent).

### Auth / operator gate

**WT-60 · [High] · P3 · CONFIRMED — There is no logout control anywhere in the operator UI; `/api/auth/logout` is a dead endpoint**
- Where: `api/auth/logout/route.ts` (works, unit-tested, called from nowhere); `OperatorShell.tsx:24-40`, `OperatorNav.tsx:13-23` (no logout in the 9-item nav).
- Wrong: The logout route signs out of Supabase and clears cookies, but nothing calls it. Once `AUTH_GATE_ENABLED` flips on, a logged-in operator has no way to end their session from the UI: a first-day hire on a shared shop tablet, or anyone leaving the business, stays signed in until the token expires.
- Fix: Add a "Sign out" action (OperatorNav or accounts page) that POSTs the existing route then redirects to `/login`.
- Needs Naldo: no.

**WT-61 · [Med] · P4 · CONFIRMED — Open redirect on the login page via the `from` query param (protocol-relative bypass)**
- Where: `src/app/login/page.tsx:14,34`.
- Wrong: `from` is read from the URL and guarded only by `from.startsWith('/')`. A protocol-relative `//evil.com/x` also starts with '/', so it passes, and the router performs a real cross-origin navigation. The middleware only ever writes safe same-origin paths, so it is reachable only via a hand-crafted link: the phishing vector is staff log in for real on the legit domain, then land on an attacker page positioned to re-harvest.
- Fix: Also reject a second leading slash (`!from.startsWith('//')`) or resolve via `new URL(from, origin)` and compare origins.
- Needs Naldo: no.

**WT-62 · [Low] · P4 · CONFIRMED — The staff-device cookie is never cleared, so a repurposed device silently suppresses real customer view signals**
- Where: `api/operator/mark-device/route.ts` (1-year httpOnly cookie); `api/auth/logout/route.ts:9-13` (doesn't clear it); `src/lib/auth/staffDevice.ts:20` (no unmark path).
- Wrong: Any browser that opens the operator console gets `yll_staff_device=1` for a year, with no clear path. If that tablet/laptop is later handed to a customer, their own view/interest on their own quote link is swallowed by staff-preview suppression, and nobody knows why. Compounds with WT-60 (no logout moment to clear it).
- Fix: Clear the cookie in the logout flow and/or shorten its lifetime.
- Needs Naldo: no.

### Cross-vertical consistency (dedicated diff)

**WT-63 · [High] · P4 · CONFIRMED — Permanent, event, and bistro have Settings-editable pricing rates; holiday does not**
- Where: `pricingEngine.ts:12-40` (`BUSINESS_RULES` hardcoded) vs `PermanentRatesSettings.tsx` / `EventRatesSettings.tsx` / `PermanentBistroRatesSettings.tsx` (all wired to `/api/settings`).
- Wrong: Holiday's roofline $/ft, rush ($150), takedown ($150), tax (8.75%), deposit (50%), minimum ($1,000), and early-install discounts are all hardcoded with no Settings UI and no `app_settings` row, while the three newer verticals each got a rate-table panel. The highest-volume vertical is the only one that needs a deploy to retune.
- Fix: Add a `HolidayRatesSettings` panel backed by `app_settings` (mirror the three proven panels), or explicitly accept that holiday rate changes are deploy-only.
- Needs Naldo: yes.

**WT-64 · [Med] · P4 · CONFIRMED — Permanent has a Settings-editable Annual Maintenance Plan add-on; bistro (same year-round shape) has none**
- Where: `permanent/types.ts:65-66,125-135` + `permanent/pricing.ts:89-95` vs `permanentBistro/types.ts` (`{perFt, perPole, minimum}` only).
- Wrong: Both are permanent year-round installs sold with a warranty, but only permanent got the recurring-revenue maintenance-plan line item. There is no way to sell a maintenance plan on a bistro job even though the same string-light hardware needs the same service work.
- Fix: Ask whether bistro should get the same optional maintenance-plan field (mirrors the permanent pattern), or accept the gap.
- Needs Naldo: yes.

**WT-65 · [Med] · P4 · CONFIRMED — Permanent's warranty copy is staff-editable; holiday/event/bistro guarantee copy (including bistro's warranty terms) is hardcoded in source**
- Where: `appSettings.ts:57-151` (`permanentWarranty` versioned) vs `RiskReversal.tsx:11-37` + `portal/[quoteId]/approved/page.tsx:100-171` (hardcoded strings).
- Wrong: Same asymmetry as WT-56/WT-63, restated as a portal-copy pair: changing a warranty promise made to every bistro or event customer requires a PR + deploy, while permanent's does not.
- Fix: Extend the Settings-editable pattern, or accept the asymmetry given low change frequency.
- Needs Naldo: yes.

---

## Live portal findings (in-browser, all four verticals)

These were caught by driving the four seeded prod portals (holiday/permanent/bistro totals all
reconciled; tax 8.75% consistent). They are UX/copy issues a static code read does not surface.

**WT-L1 · [High] · P1 · LIVE — A booked, deposit-paid event portal renders $0 and "select items to continue"**
- Where: `https://quote.yulelovelights.com/portal/b4dad6bc…` (booked event fixture).
- Wrong: The top banner says "You're booked — approved July 4, 2026. Your deposit is in." and the package card says "Event Lighting $2,544.75", but the hero shows `$0 / $0 deposit`, every line item shows "OFF", the tie-out shows `Total $0`, and it displays "Our minimum is $1,000. Select items to continue." on an already-booked order. This is the known locked-portal render bug (prior audit HIGH: locked portal seeds defaults, not the frozen approved selection), but on event the default seed selects nothing, so it renders $0 rather than merely the wrong number. Worse than the holiday manifestation.
- Fix: Same as the known fix (seed `SelectionProvider` from the frozen approval snapshot when `quote.approval` exists). Flagged as a new, more severe live manifestation.
- Needs Naldo: no (already a known fix target).

**WT-L2 · [Low] · P1 · LIVE — The "Your {packageName} — line by line" header reads wrong on holiday and empty on event**
- Where: holiday portal shows "Your **Our Recommendation** — line by line" (double possessive); booked event shows "Your ␠ — line by line" (empty package name). `WhatsIncluded.tsx` heading template.
- Wrong: The template inserts the package name verbatim. Holiday's recommendation package is literally named "Our Recommendation", producing "Your Our Recommendation". Event's booked/locked render has no active package name, producing a blank.
- Fix: Special-case the recommendation package ("Your recommended design — line by line"), and provide a fallback when no package name is active.
- Needs Naldo: no.

**WT-L3 · [Low] · P1 · LIVE — The event portal shows the holiday color palette (Candy Cane / Christmas / Frozen) on a wedding quote**
- Where: event portal Light Color picker.
- Wrong: The event→holiday analyzer/portal fallthrough (intentional in general) leaks holiday-themed palette names onto an event/wedding portal. A wedding customer sees "Candy Cane", "Christmas", "Frozen" as color options.
- Fix: Give event its own palette label set (or a neutral one) rather than inheriting holiday's seasonal names.
- Needs Naldo: yes (is event meant to share the holiday palette?).

**WT-L4 · [Low] · P3 · LIVE — "Watch before you approve" walkthrough copy shows on a booked/approved quote**
- Where: booked event portal, "Walkthrough from Naldo" section.
- Wrong: The section still says "Watch before you approve" on a quote that is already booked and paid. Stale CTA on the post-approval view.
- Fix: Swap the CTA copy on booked/approved quotes ("Here's the walkthrough for your booked install").
- Needs Naldo: no.

---

## Cross-area inconsistency ledger

Pairs that should match but don't (the reason this wide sweep exists). Each row: the two places
+ the divergence.

| # | Place A | Place B | Divergence |
|---|---|---|---|
| 1 | Holiday rates (`pricingEngine.ts` `BUSINESS_RULES`) | Permanent/event/bistro rate panels (`*RatesSettings.tsx`) | 3 verticals Settings-editable; holiday (top volume) hardcoded, deploy-only (WT-63) |
| 2 | Permanent warranty (Settings-editable, versioned, frozen) | Holiday/event/bistro guarantee copy (`RiskReversal.tsx` hardcoded) | Only permanent is editable; other 3 need a deploy (WT-56/WT-65) |
| 3 | Permanent "Your Protection" (live editable) | Permanent FAQ warranty answer (`mockQuote.ts` hardcoded) | Same page, same vertical, can say two different things (WT-11) |
| 4 | Permanent maintenance-plan add-on | Bistro (same year-round shape), no maintenance field | Recurring-revenue add-on exists for one, not its sibling (WT-64) |
| 5 | rush/takedown zeroing for event + bistro | Plain permanent (omitted) | Defense-in-depth covers 2 of 3 non-holiday verticals (WT-06) |
| 6 | Permanent/event/bistro cards show "Pending" | Holiday card (no pending count) | Core-business vertical is the only one with no funnel visibility (WT-39) |
| 7 | Deposit webhook (has duplicate-charge guard) | Balance webhook (none) | Same payment processor, one path guarded, one not (WT-14) |
| 8 | Holiday pushes analyzer result to `seed_analysis` | Permanent path never does (jumps always empty) | Training loop fires for one vertical, silently never for the other (WT-35) |
| 9 | Holiday training tab (corrections editor) | Permanent training tab (read-only) | Bad AI trace fixable for one, only deletable for the other (WT-37) |
| 10 | Homepage "Conversion" (`approved/sent` label, no terminal check) | Insights "Close ratio" (`approved/reached`, terminal-aware) | Two different numbers for one metric; homepage label also wrong (WT-48) |
| 11 | Inbox "Follow-up reminder (days)" label | Actually controls the stale badge, not the follow-up strip | Setting name describes a feature it doesn't govern (WT-44) |
| 12 | Every quote GHL path (`resolvePipelineStages(service_type)`) | Inbox Mark-Handled (legacy holiday env vars) | Non-holiday leads land in the holiday pipeline (WT-49) |
| 13 | Lead `landscape` (never-wired env vars) | Bistro rides the same live Landscape pipeline via `ghlPipelineMap` | Website landscape leads get no card; bistro cards move fine (WT-50) |
| 14 | Reference Library garland sizes `['9ft','6ft']` | Canonical `GARLAND_LENGTHS` `['4.5ft','9ft']` | UI offers a fake size, omits a real one (WT-32) |
| 15 | Portal package eyebrow "Tier N" | Permanent packages are surfaces; event/bistro are single-package | Ordinal tier label misdescribes 3 of 4 verticals (WT-10) |
| 16 | Kanban card (Test badge) | Print sheet / emailed order / work-order modal (no badge) | Test job looks real on the surfaces staff act on (WT-30) |
| 17 | Permanent minimum ($2,500, editable), bistro (editable) | Event minimum (inherits holiday $1,000, not tunable) | 3 of 4 verticals get an editable floor; event doesn't (WT-59) |
| 18 | Portal "Your {packageName}" template | Holiday "Our Recommendation" / event empty | Header renders wrong copy per vertical state (WT-L2) |

---

## Missed opportunities (strategic gaps)

Led by the commercial gap, per the sweep's mandate.

1. **Commercial / multi-property is structurally unsupported (the #1 miss).** There is no property
   or building entity: the data model is customer → one quote → one address. A stated target buyer
   with several buildings has nowhere to live in this tool: no account grouping, no one-invoice or
   one-PO rollup across sites, no portfolio/volume pricing, no single portal login spanning
   properties. The backend has a half-built `properties` table (WT-52/WT-53) that the UI never
   reads, so even the groundwork that exists is dead. Completing multi-property is the highest-value
   strategic build in this report.
2. **Premium / luxury-tier experience is thin and unaudited on the operator side.** The live portal
   walk showed the customer side is polished, but there is no white-glove concierge path, no
   property/site labeling for a buyer juggling multiple links (WT-12), and no price-legibility pass
   on the operator screens. A demanding P1 homeowner's confidence rests on details a code audit
   can't see; a dedicated in-browser premium-feel pass is worth doing.
3. **The design editor's projection math is money-bearing and never adversarially audited.** Drawn
   geometry becomes billed dollars, and reopen/rehydrate is a known recurring failure class, yet no
   finder verified projection integrity or yardstick scale. Worth a focused money-lens sweep of
   `editor-core` before the next big design-editor change.
4. **The lead-to-quote funnel leaks and has no attribution audit.** Landscape leads silently defer
   with no card (WT-50); lead dedup and attribution were only seen as GHL side effects. The top of
   the funnel is the thinnest-covered money-adjacent stage.
5. **Cross-vertical feature parity has no owner.** Individual intentional exclusions are confirmed,
   but no one maintains the full matrix of which vertical has vs lacks each capability (referral
   credit, warranty editing, color/effect picker, scheduling, rush/takedown, analyzer, maintenance
   plan). Accidental gaps hide in the cells nobody maps. A one-page parity matrix would turn each
   future "should bistro get X?" into a deliberate yes/no instead of a silent inherit.

---

## Ledger-worthy new tasks

Suggested for `task_ledger.md` (grouped; ids are this report's, not ledger numbers):

**Money / correctness (do first):** WT-14 (balance double-charge guard) · WT-16 (collect-payment
confirm) · WT-17 (cancel refund = full balance) · WT-01 (stale roofline → $0) · WT-27 (bistro PO
"not in catalog") · WT-49 (Mark-Handled wrong pipeline) · WT-35 (permanent jumps training dead).

**Security / PII:** WT-29 (print work-order auth) · WT-30 (test-job badge on print/email) · WT-61
(login open redirect) · WT-60 (operator logout) · WT-62 (staff-device cookie clear).

**Owner visibility / reconciliation:** WT-38/WT-46 (dashboard $0-on-failure) · WT-47 (500-cap
caveat) · WT-48 (conversion vs close-ratio) · WT-20 (cancelled invoice reconcile flag) · WT-39
(holiday pending count) · WT-42 (response-trend timestamp) · WT-41 (inbox 100-cap).

**Dead / half-wired features (decide finish-or-remove):** WT-19 (scheduled status + install_date)
· WT-22 (locked flag) · WT-23 (hide-category setting) · WT-44 (follow-up-days setting) · WT-02
(aLaCarteTotal) · WT-13 (package tagline) · WT-33 (degraded few-shot signal).

**Consistency / copy (batch):** WT-06 · WT-10 · WT-11 · WT-32 · WT-39 · WT-40 · WT-56 · WT-57 ·
WT-58 · WT-63 · WT-64 · WT-65 · WT-L1..L4 · WT-45 · WT-09 · WT-34 · WT-26.

**Needs a Naldo decision (business call, not a bug):** WT-03 (multi-building footage) · WT-07
(bistro warranty editable?) · WT-12 (portal address) · WT-18 (amend re-consent gate) · WT-28
(low-stock PO path) · WT-43 (follow-up re-arm) · WT-50 (landscape pipeline) · WT-54 (permanent/
bistro referral reward) · WT-59 (event minimum) · WT-64 (bistro maintenance plan) · WT-L3 (event
palette) · the commercial / multi-property build.

---

## Method + model mix

- **Enumeration:** inline globs/greps mapped ~110 routes, ~110 API handlers, ~313 lib modules, 4
  verticals (holiday/permanent/event/permanent_bistro), all settings + components, into a 21-area
  coverage list.
- **Finders:** 21 area agents (Sonnet, high effort), each persona-tagged, seeded with the
  intentional-design guards and the known-findings ledger so deliberate behavior and already-filed
  items were not re-reported.
- **Verify:** one adversarial verify pass per area (Sonnet, high effort, refute-first): 66
  candidates → 65 confirmed, 1 refuted (event minimum). 0 duplicates survived.
- **Completeness critic:** Opus, over the coverage map, surfaced the 5 under-examined surfaces and
  the missed-dimensions list (led by the commercial gap) reproduced above.
- **Live:** the four seeded prod portals were driven read-only in the browser; no real message,
  payment, or row was touched. The seeded fixtures `9f7e62e2…` and `b4dad6bc…` were not deleted.
- **Workflow run:** 43 agents, 0 errors, ~5.2M subagent tokens, ~66 min wall clock.
- Report only. No code changed, no branch, no merge.
