# Permanent Lighting Vertical — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Permanent Lighting (Omni/Ascend RGB puck-on-track) service vertical in the quote tool — quote builder sections, pricing, auto-BOM ("the plan"), design/portal variant, and full #82 inventory integration — mirroring the Christmas framework without regressing it.

**Architecture:** New pure modules per concern (`permanentPricing.ts`, `permanentBom.ts`, `derivePackagesPermanent.ts`) branched on the existing `quotes.service_type`, with adjustable rates in `app_settings` (the #101 pattern). Front footage comes from the design (bulbType=`permanent` strands + `sideOfHouse` tags — both already exist), sides/back from satellite measurement. **`permanent` is the ONLY new branch; every other `service_type` (`holiday`, `event`) keeps its CURRENT behavior unchanged** — the code that runs today for non-permanent quotes is untouched (today that path is holiday-shaped, and Event rides it too; this vertical adds no Event logic and removes none).

**Tech Stack:** Next.js 16 / React / Supabase (existing stack) · Konva design editor (existing `permanent` bulb renderer) · vitest TDD.

**Ledger:** implements #88 (permanent section); touches #96 (per-type portal); explicitly does NOT build #85 (recurring billing) — maintenance is a simple add-on line item.

---

## Context — why

Permanent lighting (Glow365) is YLL's second service line: Omni/Ascend RGB puck lights in aluminum track, mounted under soffit / on fascia, roofline only (front + left + right + back; gutter lines + peaks; NO ridge, NO wreaths/garland/accessories). Customer controls colors year-round via the SurpLife app. Today quoting is a manual Excel estimator from the supplier; Naldo wants it in the tool exactly like Christmas: pick **Permanent** at quote creation → design the front → measure sides/back off satellite → packages A/B/C on the portal → auto-generated install plan/BOM per quote → inventory + ordering integration.

## Locked decisions (Naldo, 2026-07-02 — don't re-ask)

| Topic | Decision |
|---|---|
| Retail rates | **$40/ft front · $35/ft sides+back · $2,500 job minimum — ALL adjustable** in Settings (app_settings, #101 pattern) |
| Materials ≠ price | **The customer pays $/ft flat. Extensions / splitters / power boxes / boosters / transformers NEVER get added to the customer's quote** — they're absorbed into the per-ft rate. They ARE computed on the BOM/cost side (P2/P7) purely for ordering + the margin-vs-retail figure the operator sees. (Confirmed Naldo 2026-07-02; matches the Greg/Melissa example sheets — price was $/ft, materials were the cost column.) |
| Packages | **A = Front · B = Sides (left+right as ONE) · C = Back.** Any combination; each priced by its own footage. NOT the Christmas cumulative ladder |
| Front footage | From the drawn design (Street View photo, `bulbType='permanent'` strands, `sideOfHouse='front'`) |
| Sides/back footage | Measured off the **satellite view** (reuse the satellite measuring the builder already has); manual override allowed |
| Corners | Every end/corner/transition consumes **3 single lights** (Omni rule). **Auto-count from the front design geometry + manual count fields** for sides/back |
| Track choice | **Soffit → single track; fascia → parapet track.** White (9003) default |
| SKU options | **Defaults + per-quote override**: standard pucks + white track by default; staff can switch puck housing (standard/black) and track color per quote |
| Design colors | **Render-only** (pucks are RGB; customer app picks real colors). Portal shows **warm-white ↔ favorite-color toggle** on the same design |
| Install plan / BOM | **Full BOM on the admin quote page** (operator-facing, printable): tracks by style/color w/ 6% waste, sets-of-5 + singles, transformer sizing, power-T injections, boosters, extensions, accessories + **wholesale cost + margin vs retail** |
| Inventory | **Full #82 integration**: Ascend SKUs → inventory_catalog, bindings, materialsProjection, supplier-PO flow |
| Money flow | **Same 50% Valor deposit / 50% balance** (#83 pipeline unchanged) |
| Job minimum | **$2,500 is an approval GATE** (portal blocks approving a selection under it — same mechanism as the Christmas $1,000 gate), NOT a price floor |
| Corner rule | Every end/corner/transition = 3 singles; **a gable peak counts 3** (both base transitions + the apex) → count every polyline vertex incl. endpoints |
| Left/Right | **Separate Left + Right footage/corner fields** in the builder (measured separately off satellite); they SUM into package B "Sides" |
| Maintenance plan | **Optional add-on line item**; price = **adjustable in Settings, default 0 = feature hidden** (Naldo sets the number later; no recurring engine — #85 later) |
| Portal copy | Permanent-specific: **lifetime warranty on materials** (vs Christmas 24–48 h fix), app color control, track hidden by day (matched to trim), security-lighting benefit, phone troubleshooting, no seasonal takedown |

## Domain math (from supplier docs — the BOM engine's spec)

- **Pucks 8" on-center** → `puckCount = ceil(ft × 1.5)`. Supplied as **sets of 5** (40" strip, APL11012-5, $15.52 whl) + **singles** (8", APL11012-1, $3.85). Black variants `-BLK`, same price.
- **Corners/ends/transitions: +3 singles each** (the estimator's "Adds 3 Singles per").
- **Tracks: 40" sections** → `ceil(ft / 3.333)` **+ 6% waste**. SKUs: `APL11210-<color>` single $7.33 · `APL11220-<color>` double 2-pc $7.95 · `APL11230-90-<color>` parapet 90° $8.38. Stock colors: white 9003 / black 9004 / cream 9012 / dark-brown 8019 (+ bronze 8022, light-grey 7045 double). Custom powder-coat = 6-week lead.
- **Transformers (12 V):** 350 W → 210 ft / 300 pucks ($251.94; **KIT** w/ wifi hub + booster + female adapter $345.44) · 600 W → 340 ft / 510 pucks ($342.85; KIT $433.75) · 150 W → 80 ft / 120 pucks ($137.75). Suggest ≤ 85% load; size/count from puck count.
- **Power injection:** Power-T (APL11123, $5.85) **every 75 pucks**; never leave **> 35 lights (25 ft) un-injected** tail. 16/2 wire, ≤ 2 injection points per wire, WAGO connectors.
- **Data:** wifi hub (APL11120) controls up to 2048 pucks / max 500 per segment. **Signal booster** (APL11121, $12.66) when controller > 10 ft from first light OR any > 50 ft gap. Splitter (APL11122, $6.65).
- **Extensions:** 3'/$2.94 · 5'/$3.46 · 10'/$4.61 · 25'/$10.71 · 50' w/ booster $33.77. Female adapter APL11126 $2.92 (one per system start). Wire end caps APL11330 (bag 25). Screws 100-pk, loom tube.
- **Reality check** (Naldo's real jobs): 125 ft ≈ $1,229 materials (~$9.83/ft cost) → healthy margin at $40/35 retail. $720 ≈ fixed labor (informational only, not billed as a line).

## What already exists (recon-verified — reuse, don't rebuild)

- `ServiceType = 'holiday' | 'permanent' | 'event'` — [serviceType.ts](src/lib/serviceType.ts); `quotes.service_type` column + index + `form.serviceType` in [quoteForm.ts:30](src/lib/quoteForm.ts) (builder UI doesn't switch sections yet).
- Dashboard already splits by service type — `computePermanentSummary` in [serviceMetrics.ts:84](src/lib/dashboard/serviceMetrics.ts).
- Design editor already has: `BulbType 'permanent'` + permanent puck renderer ([editor-core/permanent.ts](src/components/design/editor-core/permanent.ts), `PERM_DEFAULTS`, spacing options incl. 8") + `sideOfHouse: 'front'|'back'|'left'|'right'` tags shown for permanent strands ([editor.ts:2326](src/components/design/editor-core/editor.ts)) — the #103 relay work.
- `projectScene.ts` explicitly skips `permanent` strands today (renders only, no line items) — the projection seam.
- app_settings mechanism + Settings editor pattern (#101 swatches) — [appSettings.ts](src/lib/appSettings.ts).
- #102 `resolveRate()` custom-$/ft pattern in [pricingEngine.ts:331](src/lib/pricing/pricingEngine.ts).
- Satellite measuring already exists in the builder's satellite tab (used for WW footage) — reuse for L/R/B.
- Inventory #82: `inventory_catalog` table, bindings vocabulary ([concepts.ts](src/lib/inventory/concepts.ts) — comment says "permanent = future feature"), `materialsProjection.ts`, generic `purchaseOrder.ts` (auto-picks-up new concept categories), `parseThunderCsv.ts` importer.
- Money pipeline #83 (approve → job → invoice → Valor) is service-agnostic off `quote.total` — untouched.

## Constraints

- **Multi-dev:** portal/quote/pricing/design/editor-core/settings = **Jason's area** — every PR flagged for his review; Naldo gives merge-go. **Avoid `editor-core/**` edits** (byte-identical relay burden with the separate design-tool repo); prefer lib-level + quote-binding-panel-level seams. Flag any unavoidable editor-core touch.
- **Zero regression to existing service types:** the `permanent` branch is the only new code path; `holiday` and `event` quotes fall through to today's exact behavior (unchanged). Full gates (tsc · lint · vitest) per PR; adversarial review on money-adjacent PRs (pricing, BOM, approve-snapshot).
- New pure modules over threading branches through the 800-line holiday engine.

## Execution policy — model routing & production guardrails (Naldo, 2026-07-02)

**1. Work auto-routes to the right model tier (silent, automatic):**

| Tier | Model | Does |
|---|---|---|
| DOWN | **Haiku 4.5** | reads: recon, file location, doc lookups, log scans |
| DOWN | **Sonnet 5** | builds: routine implementation, tests, UI components, docs |
| ME-SEAT (default) | **Opus 4.8** | plans, judges, reviews: phase orchestration, adversarial review passes, PR review, disposition of findings |
| UP | **Fable 5** | top-tier — **always asks first**, never silent |

**2. Only 2 interruptions ever:** "use the expensive model?" and "ship to production?". Everything else proceeds without stopping.

**3. Top-tier (Fable 5) = design, danger, or money ONLY** — architecture calls, production debugging, security review, migrations. **Never routine coding. ~20% of the work, max.** In this plan that means Fable is ask-first-eligible for exactly: the P1 money-math adversarial verdict, the P6 approve/amend money-path review, the P8 prod catalog migration, and any live production debugging. All other work runs on the DOWN/ME-SEAT tiers automatically.

**4. Every production change is guarded:** `branch → PR → automated checks (tsc · lint · vitest) → merge → deploy → verify`. **The AI never merges itself** — before any merge it shows Naldo a **plain-English summary derived from the actual code diff** (not from intent) and waits for an explicit "go". (Extends the existing AGENTS.md human-merge rule; Jason-area PRs also carry his review flag.) Post-merge, the deploy is verified in-browser, not assumed.

**5. Model fallback:** if a tier's model is down/unavailable, work **drops exactly one tier** (Fable → Opus → Sonnet → Haiku) and **says so** in the output. For anything risky (money math, prod migrations, approve/amend paths, security), it does NOT silently substitute — it **stops and asks** first.

---

# Phases (8 PR-sized, each independently shippable + gated)

## ⚖️ Council review (2026-07-02) — verdict: APPROVE WITH REVISIONS, no restructure

An 11-agent LLM Council (5 advisors → anonymized peer review → chairman) reviewed this plan. Unanimous: the architecture + waves stand. **Mandatory revisions (all folded into the phases below):**

1. **FATAL (P1+P6): rate-drift at approve.** The approve route re-prices server-side with LIVE app_settings rates — a Settings rate edit would silently change the total Valor charges on an outstanding quote. Fix: freeze the FULL `PermanentRates` into the quote's stored result at calc/save (`QuoteResult.permanentRatesSnapshot`), and the approve re-price consumes the frozen snapshot, never live `getAppSettings`. Test: rate changed after save → approve total unchanged.
2. **P6:** don't overload `colorSchemeId` for the warm-white↔color toggle (collides with `isKnownColorSchemeId` + the #101 approve-time colorIds freeze). New `permanentColorChoice` field through approve → snapshot.
3. **P2:** the transformer spec is internally contradictory (350W: 210 ft ⇒ 315 pucks vs 300-puck rating; ≤85% headroom vs boundary tests). **Resolve with the supplier which limit binds (ft vs pucks) + whether 85% applies to both** before writing `sizeTransformers`; make Test 5 self-consistent.
4. **Pre-P2 sequencing:** get Naldo's CURRENT estimator sheet + the Thunder CSV NOW (not at P8); golden-test against 2–3 real current jobs, not just the one older 125-ft example.
5. **P4/P2 (revised again by Naldo 2026-07-02):** no dead precision — but gaps ARE collected per quote (the estimator's extension rows). `PermanentSection` gets `controllerToFirstLightFt` + a **gaps repeater** (length ft + splitter checkbox); the BOM derives **extensions (sized per gap), splitters, and >50-ft boosters** from them.
6. **P5:** key `lineItemKind` + package composition on the **stable ids** (`permanent-front`…), never display-string regexes (a copy tweak must not break packages).
7. **Cross-phase exposure window:** after P4 merges, a sent permanent quote would render through the HOLIDAY portal (wrong packages/gate/copy) until P5+P6 land — `master` auto-deploys per PR. Fix: **feature-flag the Permanent picker** (app_settings `permanentEnabled`, default false) flipped only after P6 is live.
8. **P5/P6:** a back-only package can price under the $2,500 gate (unbuyable) — portal disables sub-gate packages with an "add more to reach $2,500" prompt. Tax treatment **CONFIRMED by Naldo (2026-07-02): same 8.75% as Christmas** — P1's tax test uses 8.75%.
9. **P7:** may ship before P8 only with a **"PROVISIONAL SKU — verify against estimator" watermark** on the printable sheet.
10. **Sequencing:** ship gate = **P1–P6** (~2 weeks). P7 fast-follow. **P8 explicitly decoupled — must not gate the sales push.** P4→P3 is a HARD dependency (live rates must come from settings). `projectPermanentDesign`'s `unassigned` bucket is surfaced in the builder UI, never silently dropped.

**Phase 0 (DO FIRST, 30 min):** the color-toggle spike — load a design with `bulbType='permanent'` strands and verify `buildRenderColorMap` / `render-readonly.ts:187` actually recolors them via `colorOverride`. It's the only unresolved fact that changes the plan's shape: if it fails, editor-core edits + the byte-identical design-tool relay + Jason coordination enter scope and the 2-week estimate is wrong.

## Review hardening (2026-07-02 gap review, 4-lens + code-verified — fold into the phases at build time)

A second review (after the council) caught correctness gaps; three were VERIFIED against live code. **Every item below is mandatory.**

**HIGH — money-path correctness (verified in code):**
- **[H1] Amend re-price must consume the frozen snapshot, not live settings.** The rev-#1 snapshot only protects *approve*; the common permanent workflow is a **post-site-visit amend**, which forces a re-Calculate through `/api/quote` — specced to read `(await getAppSettings()).permanentRates` = LIVE rates. Verified: [amend/route.ts:117](src/app/api/quotes/[id]/amend/route.ts) reads `quote.result.total` and 409s `no-change` (:144) unless the builder already re-Calculated; that re-Calculate ([quote/route.ts:232](src/app/api/quote/route.ts)) + `updateQuote` overwrites `quote.result` with a fresh snapshot from live rates. **Fix in P4:** when `/api/quote` re-prices an EXISTING permanent quote (valid `quoteId`), price from the stored `quote.result.permanentRatesSnapshot`; only a brand-NEW permanent quote reads live settings. Add the P6 test (book → change settings → edit footage → re-Calculate → amend → total uses ORIGINAL snapshot).
- **[H2] Branch on the STORED `service_type`, not the request body.** Verified: [quote/route.ts:258](src/app/api/quote/route.ts) passes `serviceType ?? undefined` ("undefined → leave stored untouched on update"). A permanent update that omits `serviceType` in the body evaluates the P4 branch false → permanent inputs run through the holiday `calculateQuote`, writing a holiday-shaped result over the permanent one + losing the snapshot. **Fix in P4:** on update, derive the pricing branch from the stored row's `service_type` (fetch it), or 400 a permanent-inputs body whose `serviceType` isn't permanent. Test: update an existing permanent quote with `serviceType` omitted → still `calculatePermanentQuote`.
- **[H3] Patch the SECOND gate call site + gate on the SELECTED SET.** Verified: `minimumOrderSubtotal` is also called at [approve/route.ts:454](src/app/api/quotes/[id]/approve/route.ts) — a site P5 misses, so the portal blocks sub-$2,500 but the server still gates at the holiday $1,000 (a forged/edge approve of a $1,000–$2,500 permanent quote passes). **Fix in P5:** add `approve/route.ts:454` to the file list; derive `minimum` from `permanentRatesSnapshot?.minimumJobAmount ?? 2500`; test a server-approve between $1,000–$2,500 is rejected. AND evaluate the gate on the customer's SELECTED-SET subtotal in `SelectionContext` (per-package disable is only a hint) so front $2,200 + back $2,100 = $4,300 is buyable; test it.
- **[H4] Multi-transformer BOM math is per-SEGMENT, not whole-house.** `powerInjectionCount(pucks)` + `boosterCount` + the 500-pucks/segment data rule apply **per powered segment**, but the plan feeds whole-house totals — a ~400ft/~600-puck job (2 transformers) under-orders injections, boosters, and hubs. **Fix in P2:** `sizeTransformers` returns distinct UNITS each with an allocated puck/ft load; compute injections + boosters + data-segments PER unit and sum. Add a ~600-puck 2-transformer golden test. (Fold "does each transformer need its own hub?" into the rev-#3 supplier question.)

**MEDIUM — fold into the named phase:**
- **[P1]** Grep `computeTotalsTail` for the EXACT fee field names it reads (they differ from `rushFee/takedown/installTiming` booleans); enumerate every `QuoteResult` field the permanent result must populate (subtotal(s), taxable, tax, total, deposit, lineItems) so the adapter/`chargesFromResult`/`effectiveTaxRate`/packages never hit `undefined`. Add a "permanent result is structurally complete" test.
- **[P4]** Specify `projectPermanentDesign` runs **client-side** in `PermanentSection` to pre-fill form state once (or on an explicit "refresh from design"); the form value is source of truth after, the route trusts submitted `frontFootage`. Test: design pre-fills front; a manual override persists across re-Calculate.
- **[P4]** All-manual (no-design) quote: warn visibly when `frontFootage=0` but front is expected; keep front footage/corner chips always manually editable.
- **[P4]** Guard `service_type` mutation on a saved quote (route → 400, or clear the type-specific block on a deliberate switch); test both directions. Also covers the flag-off window.
- **[P4]** `QuoteBuilder.tsx` is a SHARED behavioral fork — gate the permanent satellite line-sets + the round-to-5 effect (`:595`) fully behind `serviceType==='permanent'` with their own state; holiday paths byte-identical. Add an **in-browser holiday-satellite regression** as an explicit P4 verify step (tsc won't catch a shared-effect break). Add a regression test that `projectScene` STILL skips `bulbType='permanent'`.
- **[P5]** `derivePackagesPermanent` tax source = `effectiveTaxRate(result)` (NOT a literal — a stale `0.08625` already lives in `derivePackages.test.ts`). Cross-check test: package total for {front} == approve total for the same selection.
- **[P6]** Define ONE missing-snapshot fallback everywhere approve/amend consume it: if a permanent quote reaches approve/amend with a null snapshot, re-derive rates from the stored line-item $/ft and freeze — NEVER read live settings. Test with `permanentRatesSnapshot=undefined`.
- **[rev #7]** Feature-flag semantics: `permanentEnabled` gates ONLY the builder create-picker; portal/approve/amend branch strictly on the persisted `service_type`, never the flag. Test: a booked permanent quote still approves/amends with `permanentEnabled=false`.
- **[P8]** The materials/`jobsPrepare` aggregation is bigger than "unchanged": it derives demand from each job's SCENE via `projectMaterials`, but permanent sides/back footage lives in `quote.inputs`, never the scene. Confirm the query SELECTs `quote.inputs`, branch on `service_type` → `permanentMaterialLines(inputs, bindings)`, assert its `MaterialLine` shape matches so `computePurchaseOrder` stays untouched. Add a data-loading test.
- **[P1/P2]** Track style/color are single per-quote scalars, but real houses mix soffit-single + fascia-parapet. v1: keep single-scalar but **note the limitation in Locked decisions** (operator hand-edits mixed jobs); ALSO ensure parapet jobs emit the 90° corner-track SKU (APL11230-90) or they under-order corner pieces. (Consider `trackStyleBySide` as a fast-follow.)
- **[P4/P7]** Auto-counted corners/gaps go STALE if the linked design is edited after save (BOM reads stored `inputs`, not the live scene). Add a P7 staleness flag (design `updated_at` vs quote result timestamp) prompting re-Calculate before ordering. Extend the P4 round-trip test to assert each gap's `detectedFt` + `source` survive save/hydrate (the training loop depends on that delta persisting).

**LOW — polish / call out:**
- Footage precision: satellite L/R/B round to 5ft but design-front doesn't — at $35/ft that snaps side price in $175 steps and can nudge the $2,500 gate. Pick ONE rule (recommend: don't round permanent satellite footage — footage IS the price) + note in Locked decisions; test equal front/side lengths price equally.
- Corner auto-count counts EVERY vertex — operators trace redundant points on straight runs. Count only real direction-changes past a threshold angle (or treat auto as a suggestion); test a straight run with redundant vertices → 0 corners.
- Returns/leftover-stock reconciliation (BOM over-orders via 6% waste + sets-of-5 rounding) — defer past ship gate, but call out: leftover qty should return to on-hand so the next PO nets it out.

## Product decisions from the gap review (Naldo, 2026-07-02)
- **Install map = YES, v1 (text run-sheet).** P7 emits, alongside the order BOM, a **per-side install run-sheet** for the crew: footage · corners · track style+color · # power-T injections · which transformer # feeds it · controller/hub + booster/splitter locations · each gap/run. Text/table v1 (visual-on-photo map later). This is the other half of "the plan."
- **2 design versions = live toggle only (v1).** The portal warm-white↔favorite-color toggle recolors live; **persist the CHOSEN favorite color** to the quote (via `permanentColorChoice`) so the installer/file has it. No saved image pair in v1 (saved/emailed renders = fast-follow) — note the deferral so it's not silently under-delivered.
- **Amend money = balance absorbs the delta.** A post-site-visit amend keeps the already-charged 50% deposit as-is; the difference (up OR down) rides the final balance/invoice. The $2,500 gate does NOT re-block an already-approved job on amend. (Matches the existing #83 amend→invoice-resync; P6 amend test asserts deposit unchanged, balance = new total − original deposit.)
- **Disclosures + capture = ALL of them (v1).** P4 `PermanentSection` operator checkboxes: **WiFi confirmed at location? · power outlet near the mount? · HOA approval needed/obtained? · controller/hub location** (the last also feeds the `controllerToFirstLightFt`/booster logic, which today has no source for WHERE the controller sits). P6 portal notes: **customer supplies home internet + 2.4GHz reaching the eave · HOA/permit is the customer's responsibility · a non-stock track color is ~6-week powder-coat lead** (surface at selection with the house photo next to the 4 stock swatches; operator confirms before send). A new-outlet job is flagged as a possible change-order.
- **Warranty terms (Naldo-confirmed 2026-07-02) — final, drives the P6 RiskReversal + contract copy:**
  - **Covers MATERIALS only.** Labor to diagnose/repair/replace is always billed to the customer.
  - **Lifetime, UNCONDITIONAL** — valid as long as the ORIGINAL customer owns + lives in the house. NOT tied to the maintenance plan (maintenance stays a separate optional add-on).
  - **Non-transferable** — coverage ends if the home is sold; the next homeowner is not covered.
  - **Voids the warranty:** product cut or spliced · foreign / non-Omni parts added to the system (transformers, pucks, controllers) · serviced or modified by anyone other than YLL · physical or external damage (storm, impact, fallen branches, animals, damage from another contractor's roof/gutter/siding work) · track painted over, covered, or removed + reinstalled by others · home electrical faults (power surge, lightning, improper outlet/wiring) · roof or fascia replaced by another contractor · non-payment / breach of the install agreement.
  - **P6 implementation:** show these terms at/near the approve+deposit step; store the **terms version** the customer approved with the `approval_snapshot` (so a later wording change never rewrites what a past customer agreed to). Keep the terms text app_settings-editable (like the swatches) so Naldo can revise without a deploy.

---

**Architecture stance (verified in code):** the money spine is service-agnostic (`quotes.total` → approve → Valor → jobs → invoices); the portal is driven entirely by `QuoteResult` + `PortalLineItem[]` + `PortalPackage[]`; `service_type` already persists end-to-end. So the vertical = **a new pure engine emitting the same `QuoteResult` shape**, a pure BOM module, and thin `service_type` branches at exactly four seams: `/api/quote` ([route.ts:232](src/app/api/quote/route.ts)), the portal adapter/loader, the portal page section list, and the inventory materials path. **Zero editor-core edits** (verified: `render-readonly.ts:187` recolors any strand — incl. `bulbType='permanent'` — via the `colorPattern` swap from `colorOverride`, so the portal color toggle is portal-level only).

---

## Phase 1 — PR 1: Pure permanent pricing engine

**Goal:** TDD'd pure module turning permanent inputs into a holiday-shape `QuoteResult` so everything downstream (save/portal/approve/Valor/jobs) works unchanged.

**Files**
- Create: `src/lib/permanent/types.ts`, `src/lib/permanent/pricing.ts`, `src/lib/permanent/pricing.test.ts`
- Modify: `src/lib/pricing/pricingEngine.ts` — additive only: `export` the private `computeTotalsTail` (line ~799) + one optional `QuoteInputs` field: `permanent?: PermanentQuoteFields`

**Key types**
```ts
// src/lib/permanent/types.ts
export type TrackStyle = 'single' | 'parapet';              // soffit → single, fascia → parapet
export type TrackColor = '9003' | '9004' | '9012' | '8019'; // white / black / cream / dark brown
export type PermanentQuoteFields = {
  frontFootage: number;   // auto from design; manual override allowed
  leftFootage: number;    // satellite-measured or manual (SEPARATE fields — Naldo)
  rightFootage: number;
  backFootage: number;
  /** Jumps between runs (the estimator's extension rows): controller→first run and
   *  run→run gaps. BOM-only — retail pricing ignores them. */
  gaps: Array<{
    lengthFt: number;        // the value used for the BOM (operator's final)
    splitter?: boolean;      // line branches two directions here
    detectedFt?: number;     // what the design auto-detected (front only); undefined for manual rows
    source?: 'auto' | 'edited' | 'manual';  // training signal: 'edited' = operator corrected the auto value
  }>;
  controllerToFirstLightFt: number;
  frontCorners: number;   // auto-counted from design vertices (peak = 3: bases + apex) + adjustable
  leftCorners: number;    // manual
  rightCorners: number;
  backCorners: number;
  trackStyle: TrackStyle;
  trackColor: TrackColor;      // default '9003'
  blackHousing: boolean;       // puck housing standard vs -BLK
  maintenanceAddOn: boolean;   // add-on line; hidden while rates.maintenancePrice === 0
  frontCustomRate?: number;    // per-quote $/ft override (#102 resolveRate pattern)
  sidesCustomRate?: number;    // applies to left+right
  backCustomRate?: number;
};

// src/lib/permanent/pricing.ts
export type PermanentRates = {
  frontPerFt: number;        // 40
  sidesPerFt: number;        // 35 (left+right)
  backPerFt: number;         // 35
  minimumJobAmount: number;  // 2500 — APPROVAL GATE (portal), not a floor
  maintenancePrice: number;  // 0 = add-on hidden; Naldo sets later in Settings
};
export const DEFAULT_PERMANENT_RATES: PermanentRates;
export function calculatePermanentQuote(inputs: QuoteInputs, rates?: PermanentRates): QuoteResult;
```
Behavior: stable-id line items `permanent-front` ("Permanent Lighting – Front – 120ft ($40/ft)"), `permanent-sides` ("… Sides (left + right) – 90ft ($35/ft)" — left+right footage SUMMED into one line), `permanent-back`, `permanent-maintenance`. Honors `customLineItems`, `lineItemPriceOverrides` (presence-keyed semantics from pricingEngine.ts:656) and staff `discount`. Totals via `computeTotalsTail(subtotal, {...inputs, rushFee:false, takedown:'included', installTiming:'none'})` — holiday fees can never leak in; tax = same 8.75% as Christmas (Naldo-confirmed). Returns `rooflineChoice:'none'`, `rooflineOptions:{santas:null,gingerbread:null}`, no `fullYule`, and a new additive optional **`QuoteResult.permanentRatesSnapshot?: PermanentRates`** — the FULL rates frozen at calc time (council rev #1: the gate AND the $/ft rates; downstream consumers — the sync adapter and the approve re-price — read the snapshot, never live app_settings, so a Settings edit can never re-price an outstanding quote).

**Tests:** (1) 120ft front → $4,800 + sides 50+40ft → $3,150 + back 60 → $2,100; totals/tax/deposit(50%) match `computeTotalsTail` (tax rate per Naldo's answer — rev #8). (2) zero-footage side emits no line; NaN/negative → 0. (3) custom rate only when positive-finite. (4) `lineItemPriceOverrides['permanent-front']={amount:0}` zeroes the line into the total. (5) maintenance flag + price 500 → line; price 0 → no line. (6) rush/takedown/installTiming ignored (fees 0). (7) rates param respected; `permanentRatesSnapshot` equals the rates passed in (full freeze). (8) holiday regression: `calculateQuote` snapshot unchanged with a `permanent` block present. (9) **rate-drift guard:** result computed with rates R1; recomputing line prices FROM THE SNAPSHOT with rates changed to R2 in "settings" yields the R1 totals.

**Verify:** `npx tsc --noEmit && npm run lint && npx vitest run src/lib/permanent src/lib/pricing`. Adversarial review (money).
**Depends:** none. **Parallel:** P2, P3.

---

## Phase 2 — PR 2: Pure BOM module (`buildPermanentBom`)

**Goal:** ALL supplier math in one tested pure module. No UI/DB.

**Files:** Create `src/lib/permanent/bom.ts` + `bom.test.ts`.

**Signatures**
```ts
export type BomCategory = 'lights' | 'track' | 'power' | 'data' | 'extension' | 'accessory';
export type BomLine = { sku: string; description: string; qty: number; unitCost: number; extCost: number; category: BomCategory };
export type PermanentBomInput = {
  footageBySide: { front: number; left: number; right: number; back: number };
  cornersBySide: { front: number; left: number; right: number; back: number };
  trackStyle: TrackStyle; trackColor: TrackColor; blackHousing: boolean;
  controllerToFirstLightFt?: number;   // >10 ft → +1 booster (collected in P4's PermanentSection)
  // Naldo-confirmed (2026-07-02, supersedes council rev #5's cut): gaps ARE collected per quote —
  // the estimator's run/extension rows. Every jump (controller→first run, run→run, house→garage,
  // skipped sections) consumes an EXTENSION sized to the gap, a BOOSTER when >50 ft, and a
  // SPLITTER where the line branches two directions from one point.
  gaps: Array<{
    lengthFt: number;        // the value used for the BOM (operator's final)
    splitter?: boolean;      // line branches two directions here
    detectedFt?: number;     // what the design auto-detected (front only); undefined for manual rows
    source?: 'auto' | 'edited' | 'manual';  // training signal: 'edited' = operator corrected the auto value
  }>;
};
export type PermanentBom = {
  lines: BomLine[];
  totals: { totalFt: number; puckCount: number; cornerSingles: number; trackSections: number;
            wholesaleCost: number; costPerFt: number };
  flags: string[]; // 'custom-track-color-6wk-lead', 'un-injected-tail>35', ...
};
export function buildPermanentBom(input: PermanentBomInput, costOverrides?: ReadonlyMap<string, number>): PermanentBom;
// individually-tested sub-functions:
export function puckCountForFeet(ft: number): number;                        // ceil(ft * 1.5)  (8" OC)
export function splitSetsAndSingles(pucks: number): { sets5: number; singles: number };
export function trackSections(ft: number): number;                           // ceil(ceil(ft / (40/12)) * 1.06)  (+6% waste)
export function sizeTransformers(pucks: number, ft: number): { watts: 150|350|600; qty: number; kit: boolean }[];
// ⚠️ council rev #3: the supplier's numbers are internally contradictory (350W: "210 ft" ⇒ 315 pucks
// vs its own "300 pucks" rating; ≤85% headroom vs the boundary examples). RESOLVE WITH THE SUPPLIER
// which limit binds (ft vs pucks) + whether 85% applies to both BEFORE writing this fn + its tests.
export function powerInjectionCount(pucks: number): number;                   // Power-T per 75 pucks; flag tails >35
export function boosterCount(input: PermanentBomInput): number;               // hub>10ft → 1; each gap >50ft → +1
export function extensionsForGaps(gaps: Array<{lengthFt: number; splitter?: boolean}>):
  { extensions: Array<{ ft: 3|5|10|25|50; qty: number }>; splitters: number };
// per gap: smallest extension ≥ lengthFt (combine for >50, e.g. 60ft → 50'+10'); splitter flag → +1 splitter.
// controllerToFirstLightFt also consumes an extension sized the same way.
```
Constants table `APL_DEFAULT_COSTS` (every SKU/price from the Domain-math section). Transformer/KIT SKU codes not in the docs get provisional keys (`APL-XFMR-350-KIT`) — pinned in Phase 8 from the Thunder CSV. `costOverrides` lets Phase 7/8 feed live `inventory_catalog.wholesale_cost`. Corners = 3 singles each. Pucks per side (`ceil` per side) then summed.

**Tests:** (1) **golden**: 2–3 of Naldo's REAL CURRENT jobs (get his current estimator sheet + Thunder CSV BEFORE this phase — council rev #4), incl. the 125-ft job → wholesale ≈ $1,229 ±2%, ≈ $9.83/ft. (2) puckCountForFeet 0→0, 1→2, 100→150. (3) splitSetsAndSingles(153) → 30 sets + 3 singles; 4 corners → +12 singles. (4) trackSections 40ft → 13 (6% waste at boundaries). (5) transformer boundaries — REWRITTEN to be self-consistent per the supplier's answer to rev #3 (which limit binds + headroom); multi-unit escalation; first = KIT, rest bare. (6) powerInjectionCount(150)=2; tail>35 flags. (7) boosters: 12ft-to-first → 1; gaps [60,20] → +1 (only the >50). (8) **extensionsForGaps:** gaps [{10},{25,splitter:true}] + controller 25ft → {10':1, 25':2}, splitters:1 (matches the Greg-M sheet shape: 2×10' + 2×25' + 1 splitter for a 3-run job — exact gap lengths reconciled against his sheet in the Wave-0 golden-data pull); a 60ft gap → 50'+10' combo; gap ≤3ft → 3'. (9) blackHousing swaps `-BLK` (same price); parapet swaps APL11230-90; custom color → 6wk flag. (10) costOverrides replaces unit cost by SKU.

**Verify:** gates. **Depends:** P1 types (or land types.ts first). **Parallel:** P1, P3.

---

## Phase 3 — PR 3: Adjustable rates in app_settings + Settings editor

**Goal:** $40/$35/$35/min-$2,500/maintenance-price editable without deploy (#101 pattern).

**Files**
- Modify `src/lib/appSettings.ts` — `AppSettings.permanentRates: PermanentRates` + defaults + `sanitizePermanentRates()` (finite ≥0 only) + read-merge + patch key.
- Modify `src/app/api/settings/route.ts` — accept the `permanentRates` patch key.
- Create `src/components/settings/PermanentRatesSettings.tsx` — 5 numeric fields; mount in `src/app/settings/quotes/page.tsx`.
- Modify `src/lib/appSettings.test.ts`.

**Tests:** sanitizer drops NaN/negative/unknown; missing key → defaults (40/35/35/2500/0); partial patch preserves others; put→get round-trip.
**Verify:** gates + manual Settings edit persists. **Depends:** P1 types. **Parallel:** P2.

---

## Phase 4 — PR 4: Quote builder + `/api/quote` branch + design/satellite footage

**Goal:** operator builds, prices, saves a permanent quote end-to-end. Biggest UI PR — **flag Jason**.

**Files**
- Modify `src/lib/quoteForm.ts` — `QuoteFormData.permanent: PermanentQuoteFields` (defaults: zeros, `gaps: []`, `controllerToFirstLightFt: 0`, '9003'/'single'); `buildQuoteInputs` includes it only when `serviceType==='permanent'`; `inputsToFormData` hydrates. + tests.
- Modify `src/app/api/quote/route.ts` — validate the block (bounded finite numbers, enum tracks — mirror existing 400 guards at :160-217); branch at :232:
  ```ts
  const result = serviceType === 'permanent'
    ? calculatePermanentQuote(quoteInputs, (await getAppSettings()).permanentRates)
    : calculateQuote(quoteInputs);
  ```
  Skip `applyProjectionToInputs` for permanent.
- Create `src/lib/permanent/projectPermanent.ts` + test — pure design→footage/corners:
  ```ts
  export type PermanentGapCandidate = { lengthFt: number; fromStrandId: string; toStrandId: string };
  export type PermanentDesignProjection = {
    feetBySide: Record<'front'|'left'|'right'|'back'|'unassigned', number>;
    cornersBySide: Record<'front'|'left'|'right'|'back'|'unassigned', number>;
    /** Auto-detected FRONT gaps: the pixel distance between the END of one drawn
     *  permanent strand and the START of the next, in draw order, converted to feet
     *  via the yardstick. These become pre-filled (editable) gap rows — the design
     *  KNOWS where the lights break, so the operator doesn't retype them. */
    frontGapCandidates: PermanentGapCandidate[];
  };
  export function projectPermanentDesign(scene: Scene): PermanentDesignProjection;
  ```
  Strands with `bulbType==='permanent'` grouped by `sideOfHouse`; footage = `polylineLengthPx / pxPerFoot(yardstick)` (mirror `strandFeet`, materialsProjection.ts:94 — lib-level, no editor-core). Corners = **every polyline vertex incl. endpoints** (peak = 3: two bases + apex — Naldo-confirmed). **Front gaps auto-detected (Naldo 2026-07-02): the gap = distance from strand N's last point to strand N+1's first point (draw order), ≥ a small threshold (e.g. >0.5 ft) so touching runs don't count.** A gap over the extension range or a suspiciously long jump is flagged for the operator to confirm/split. Deterministic geometry — NOT the trained inference (that's Deferred, and only for the un-drawn sides/back).
- Create `src/components/quote/PermanentSection.tsx` — 4 footage fields (front auto-fills from design; L/R/back auto-fill from satellite; manual override chips; the `unassigned` bucket from `projectPermanentDesign` is SHOWN with a "tag these strands" hint, never silently dropped — rev #10), 4 corner fields (front auto + adjustable), `controllerToFirstLightFt` input, a **Gaps/jumps repeater** — **FRONT gaps are AUTO-DETECTED from the design** (`projectPermanentDesign.frontGapCandidates` pre-fills the rows: the tool knows where the drawn lights break) but **every auto row is FULLY EDITABLE** — the operator can correct the measured length, mark "branches here", delete a false gap, or add one the geometry missed (auto-detect is a starting point, never locked). The operator also **manually adds what the design can't show** — sides/back jumps (no design there), the controller→first-light run, and house→garage / skipped-section jumps. Each row = length ft + a "branches here" splitter checkbox → drives extensions/boosters/splitters in the BOM. Gaps live in `PermanentQuoteFields.gaps` so they persist in `inputs` and survive amends. **Training capture:** each front gap stores BOTH the auto-detected value and the operator's final value (`{ detectedFt, lengthFt, source: 'auto'|'edited'|'manual' }`), so the detected-vs-corrected delta becomes the training signal that sharpens detection over time (see Deferred). Track style/color, black-housing + maintenance toggles (maintenance hidden while settings price = 0), custom $/ft per group (#102 'custom' dropdown pattern). Note: gaps/runs affect the **BOM only** — retail pricing needs only per-side footage.
- **Feature flag (rev #7):** the Permanent option in the builder's service-type picker is gated on `appSettings.permanentEnabled` (default **false**) — flipped in Settings only after P6 is live, so an intermediate deploy can never send a permanent quote through the holiday portal.
- Modify `src/components/quote/QuoteBuilder.tsx` — wire the serviceType picker: `'permanent'` → render `PermanentSection`, hide all Christmas sections + takedown/rush/early-install (keep customer, custom line items, discount, design tab, satellite tab). Add satellite line sets `satellitePermLeftLines/RightLines/BackLines` (same `LineSegment[]` machinery at :560-563 + round-to-5 fpp effect at :595) writing `leftFootage`/`rightFootage`/`backFootage`.

**Tests:** quoteForm round-trip (permanent block survives build→hydrate; holiday unchanged); projectPermanent (side grouping, yardstick scaling, vertex-corner counts, unassigned bucket, empty scene, **frontGapCandidates: two front strands with a 4-ft break → one 4-ft candidate; touching strands (<0.5ft) → none; single strand → none; gaps returned in draw order**); route validation (bad track color → 400; permanent save carries `service_type='permanent'` + permanent result).
**Verify:** gates + manual: permanent quote → Calculate → 3-4 line breakdown + correct total; edit rehydrates; holiday untouched. **Depends:** P1, P3 (soft). **Parallel:** P5 (unit-level).

---

## Phase 5 — PR 5: Permanent packages + portal adapter plumbing

**Goal:** portal data layer understands permanent quotes (A=Front / B=Sides / C=Back, any combo, $2,500 gate) — before copy changes. **Flag Jason.**

**Files**
- Create `src/lib/permanent/derivePackagesPermanent.ts` + test:
  ```ts
  export function derivePackagesPermanent(lineItems: PortalLineItem[], result: QuoteResult): PortalPackage[];
  // A 'Front of Home' → [permanent-front]   B 'Both Sides' → [permanent-sides]
  // C 'Back of Home'  → [permanent-back]    D 'Whole Home' → all present sides (+maintenance if recommended)
  ```
  Each priced through the existing `priceSelection` (derivePackages.ts:106) with `{rushFee:0, takedown:0, taxRate}`. Absent side → package omitted. NOT the Christmas ladder. **Composition + kind detection keyed on the STABLE IDS (`permanent-front`, `permanent-sides`, `permanent-back`, `permanent-maintenance`) — never display-string regexes (rev #6). A package whose own total is under the gate renders DISABLED with an "add more to reach $2,500" prompt rather than being buyable or hidden (rev #8).**
- Modify `src/lib/portal/lineItemKind.ts` — detect kind `'permanent'` / `'permanent-addon'` from the line item's `stableId` prefix (fall back to label only for legacy rows), detail = `extractFootage`.
- Modify `src/components/portal/types.ts` — additive union member + `PortalQuote.serviceType?: ServiceType`.
- Modify `src/lib/portal/adapter.ts` — `QuoteRowForPortal.service_type`; permanent → `derivePackagesPermanent`; generalize `minimumOrderSubtotal(lineItems, minimum = BUSINESS_RULES.minimumQuoteAmount)` (default param ⇒ zero holiday change), permanent passes `result.permanentRatesSnapshot?.minimumJobAmount ?? 2500` (the frozen snapshot — rev #1).
- Modify `src/lib/portal/loader.ts` — add `service_type` to the SELECT (:52), thread to `PortalQuote`.
- Modify `src/lib/portal/satelliteLines.ts` — additive `perm-left`/`perm-right`/`perm-back` groups.

**Tests:** package combos (absent sides omitted; totals = priceSelection per footage; never rush/takedown); lineItemKind full regression table (all existing labels still parse); adapter: permanent row → permanent packages + $2,500 gate; holiday row **byte-identical** (snapshot).
**Verify:** gates; `loadPortalQuote` shape test on a P4 quote. **Depends:** P1 (ids/labels). **Parallel:** P4.

---

## Phase 6 — PR 6: Portal permanent variant (copy + color toggle + approve)

**Goal:** customer-facing permanent portal. **Flag Jason.**

**Files**
- Create `src/components/portal/dark/permanent/`:
  - `RiskReversalPermanent.tsx` — LIFETIME materials warranty copy (vs Christmas 48h fix at RiskReversal.tsx:11-16)
  - `WhatHappensNextPermanent.tsx` — no takedown step
  - `PermanentBenefits.tsx` — SurpLife app color control · track hidden-by-day matched to trim · security-lighting benefit · phone troubleshooting
  - `PermanentColorToggle.tsx` — warm-white ↔ favorite-color two-swatch control writing the existing `SelectionContext` `colorOverride` (consumed by InteractiveHero:68 → DesignCanvas → render-readonly.ts:187 recolors permanent strands — **no editor-core change**; the Phase-0 spike verifies `buildRenderColorMap` covers permanent strands BEFORE Wave 1)
- Modify `src/app/portal/[quoteId]/page.tsx` — branch section list on `portal.serviceType`: permanent = Hero · PackageCards · PermanentColorToggle · WhatsIncluded · PermanentBenefits · RiskReversalPermanent · WhatHappensNextPermanent · reviews/team/FAQ(permanent items)/contact. Drops LightColorPicker, scarcity banner, early-install/takedown UI. Holiday = default branch, untouched.
- Modify `src/components/portal/SelectionContext.tsx` — hide rush/takedown/install-timing when permanent (fees already 0 — display-only).
- Modify `src/app/api/quotes/[id]/approve/route.ts` — permanent: force `takedownSelected=false`, `installTiming='none'` in the server re-price (~:281-433) so a forged body can't add holiday fees; **the re-price consumes `result.permanentRatesSnapshot` from the stored quote, NEVER live `getAppSettings` (rev #1 — the fatal rate-drift fix)**; color-toggle choice rides a NEW `permanentColorChoice` body/snapshot field (rev #2 — `colorSchemeId` stays holiday-only; no collision with `isKnownColorSchemeId` or the #101 approve-time colorIds freeze).
- Modify `src/app/api/quotes/[id]/amend/route.ts` — **the #83 amend flow gets a permanent branch** (Naldo: final on-site measurements land AFTER approval): when the quote is permanent, the amend re-price calls `calculatePermanentQuote` with the stored `permanentRatesSnapshot` (never live settings) over the amended footage/corners/gaps; the existing versioned amendment trail + invoice/balance re-sync mechanics are untouched. The P7 BOM regenerates from the amended `inputs` automatically, so the order sheet always reflects final details.

**Tests:** approve-route: permanent re-price ignores posted takedown/installTiming, total = engine total; **rate-drift test: change settings rates after save → approve total unchanged (snapshot wins)**; `permanentColorChoice` persists to the snapshot while `colorSchemeId` validation is untouched; **amend test: amend a booked permanent quote's footage after a Settings rate change → new total uses the FROZEN snapshot rates; amendment trail + invoice re-sync fire as for holiday**; holiday approve + amend unchanged.
**Verify:** gates + manual portal walkthrough (toggle sides, color toggle recolors pucks, <$2,500 approval blocked, ≥ → Valor deposit unchanged) + holiday regression pass in-browser. **Depends:** P4, P5.

---

## Phase 7 — PR 7: Operator BOM panel + printable "plan"

**Goal:** auto-BOM on the admin quote page + printable order sheet w/ wholesale cost + margin.

**Files**
- Create `src/lib/permanent/bomFromQuote.ts` + test — `bomInputsFromQuote(inputs: QuoteInputs): PermanentBomInput | null` (null for holiday).
- Create `src/components/quote/PermanentBomPanel.tsx` — table by `BomCategory` (SKU/qty/unit/ext), totals, cost/ft, `marginPct = (retail − wholesale) / retail` vs `result.total`, flags as warnings, Print button.
- Create `src/app/quote/[id]/bom/page.tsx` — server-rendered printable view; BOM built with `costOverrides` from `listCatalog()` sku→wholesale_cost when present; `@media print` styles. **Until P8 pins real transformer/KIT SKUs, every provisional-SKU line renders a "PROVISIONAL SKU — verify against estimator" watermark on screen AND print (rev #9).**
- Modify `src/app/quote/[id]/page.tsx` — mount panel for permanent quotes only.

**Tests:** bomFromQuote mapping + null-for-holiday; margin math; catalog cost-override path (mock).
**Verify:** gates + manual: 125-ft quote ≈ $1,229 wholesale ≈ $9.83/ft; print preview renders. **Depends:** P2, P4. **Parallel:** P5, P6, P8.

---

## Phase 8 — PR 8: Full #82 inventory integration

**Goal:** Ascend SKUs in `inventory_catalog`, bindable concepts, demand projection; existing supplier-PO flow picks permanent up automatically.

**Files**
- Create `migrations/2026-XX-XX-permanent-apl-catalog.sql` — upsert all APL SKUs (both housings, 4 track colors; transformer/KIT SKUs pinned from the real Thunder/Ascend CSV via `parseThunderCsv`) with category/wholesale_cost/yll_category.
- Modify `src/lib/inventory/concepts.ts` — permanent section (reverses "permanent removed" note at :20-22): `permTrackKey(style,color)`, `PERM_LIGHT_SET_KEY`/`PERM_LIGHT_SINGLE_KEY` (+`-BLK`), transformer/hub/booster/splitter/power-T/adapter/end-cap/extension keys; seed defaults in `buildSeedBindings()`.
- Create `src/lib/inventory/permanentMaterials.ts` + test — `permanentMaterialLines(inputs: QuoteInputs, bindings: Bindings): MaterialLine[]` wrapping `buildPermanentBom` → binding keys → `{sku, qty, category, conceptKey, label}`. **Quote-inputs-driven, not scene-driven** (sides/back footage never exists in the scene) — `materialsProjection.ts` untouched.
- Modify `src/lib/inventory/purchaseOrder.ts` + materials view data path (`src/app/inventory/materials`, jobsPrepare) — jobs whose quote is permanent aggregate `permanentMaterialLines` instead of `projectMaterials`; `computePurchaseOrder`/email flow already generic (:30) — unchanged.
- Modify `src/app/inventory/bindings/page.tsx` — render the Permanent concept section.

**Tests:** permanentMaterialLines (BOM line → bound SKU; unbound → sku:null in unbound list; qty parity with the P2 golden case); PO aggregation with one permanent + one holiday job; seed-binding round-trip.
**Verify:** gates + manual: approved permanent quote → job → materials view lists tracks/sets/singles/transformer → Build PO includes shortfalls. **Depends:** P2, P4 (+P6 for the real approved-job flow). **Parallel:** P6, P7.

---

## Dependency graph / execution waves

```
P1 (pricing) ──► P3 (settings) ──► P4 (builder+route) ──► P6 (portal variant)
   │                                   ▲    │
   └──► P2 (BOM) ──► P7 (BOM panel) ───┘    └──► P5 (packages/adapter) ──► P6
                └──► P8 (inventory) ◄── P4
```
- **Wave 0 (before any code):** the 30-min color-toggle spike (Phase 0) + get the current estimator sheet & Thunder CSV from Naldo + supplier answer on the transformer limits (rev #3/#4).
- **Wave 1:** P1 → then P2 + P3 in parallel.
- **Wave 2:** P4 + P5 in parallel (P5 e2e-verifiable after P4). **P4→P3 is a HARD dependency** (rates come from settings).
- **Wave 3:** P6 + P7 + P8 in parallel.
- **SHIP GATE = P1–P6** (~2 weeks): flag flips on, first permanent quotes go out. **P7 = fast-follow** (watermarked until P8). **P8 = decoupled — must NOT gate the sales push** (rev #10).
- **Jason-flagged PRs** (his files): P4, P5, P6 (+ the tiny `pricingEngine.ts` export in P1). P2/P7/P8 are new-file/inventory territory.
- Adversarial review: P1 (money math), P4/P6 (approve/price surfaces), P8 (PO/money-adjacent).

## Build-time verifications (not blockers)

1. **P6 color toggle:** verify `buildRenderColorMap`/`resolveInstalls` recolor `bulbType='permanent'` strands via the `colorPattern` swap FIRST — if not, a small `editor-core/permanent.ts` change becomes unavoidable → byte-identical relay to the design-tool repo (`C:\Users\Jason\Desktop\YuleLoveLights\Claude`) required + confirm relay method with Jason.
2. **P8 SKUs:** transformer/KIT APL codes + WAGO/screw/loom quantity rules aren't in the docs — get the Thunder/Ascend CSV from Naldo before the catalog migration; BOM ships with provisional keys + flags meanwhile.
3. **P2 golden test** tolerance: the $1,229/125-ft example was priced on the older estimator version — if it misses ±2%, reconcile against Naldo's actual estimator sheet before adjusting formulas.

## Deferred / future (NOT in the P1–P8 build)

- **Trained gap detection — Naldo 2026-07-02.** v1 auto-detects **FRONT** gaps from the design geometry (P4 `frontGapCandidates`, deterministic) and every row is operator-editable, storing `detectedFt` vs the final `lengthFt` + `source` (P4 training capture). Two future upgrades feed off that captured data (both mirror the #8 photo-analysis loop, both always suggestions the operator confirms — never auto-order unseen):
  1. **Sharpen FRONT detection** — where operators consistently correct or delete auto rows, tune the pairing/threshold logic (which strand-endpoint pairs are a real break vs one continuous run, the >0.5 ft cutoff) and surface systematic yardstick-scale errors. The raw distance is exact geometry; *"is this a real gap"* is the judgment that learns from `source:'edited'` deltas.
  2. **Predict the UN-DRAWN sides/back** — sides/back are never drawn (satellite footage only), so their jumps + the controller/garage runs are learned from typical patterns across real jobs and pre-filled for the operator to confirm.
  Sequenced AFTER P1–P8 is live and has generated real gap data. (Also deferred: recurring maintenance billing = #85; the Event vertical = #96.)

## Verification (end-to-end, after Wave 3)

1. Full gates on the integrated tree: `npx tsc --noEmit · npm run lint · npx vitest run` — all green, holiday snapshots unchanged.
2. In-browser (dev server, real data): create a permanent quote (design front w/ permanent strands + sideOfHouse tags → footage auto-fills; satellite-measure L/R/back) → Calculate → save → send → portal shows A/B/C/D surface packages + permanent copy + working warm-white↔color toggle → approve ≥$2,500 → Valor deposit → job → materials/PO shows Ascend SKUs → admin BOM panel matches the golden math → invoice balance correct.
3. Holiday regression walkthrough: one existing holiday quote through portal→approve unchanged.
4. Adversarial review pass on the money-adjacent PRs; disposition every finding.

