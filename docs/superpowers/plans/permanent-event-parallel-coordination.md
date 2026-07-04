# Permanent ⇄ Event — parallel-build coordination

> Two new `service_type` verticals (`permanent`, `event`) built in parallel sessions. Both add a branch at the SAME dispatch seams → they collide unless coordinated. This doc: where they conflict, the isolation rule, and a kickoff prompt for the event session.

## The core fact

`service_type` is already `'holiday' | 'permanent' | 'event'`. Each vertical = a new branch at a handful of **shared dispatch points**, plus its OWN isolated modules. **The isolated modules never conflict. The shared dispatch points always do.** The whole coordination problem is those ~11 shared files.

## Conflict map

### 🟢 ISOLATED — build freely in parallel, zero conflict (different files)
| Permanent | Event equivalent |
|---|---|
| `src/lib/permanent/**` (pricing, bom, types, projectPermanent, derivePackagesPermanent) | `src/lib/event/**` |
| `src/components/portal/dark/permanent/**` | `src/components/portal/dark/event/**` |
| `src/components/quote/PermanentSection.tsx`, `PermanentBomPanel.tsx` | `EventSection.tsx`, … |
| `src/lib/inventory/permanentMaterials.ts` + the APL catalog migration | event's own (likely none — see below) |
| `src/components/settings/PermanentRatesSettings.tsx` | `EventRatesSettings.tsx` |

### 🔴 SHARED DISPATCH SEAMS — both verticals edit the SAME region → conflict
1. `src/lib/pricing/pricingEngine.ts` — `QuoteInputs` gains `permanent?` AND `event?`; the `computeTotalsTail` export (permanent adds it; event reuses — no 2nd edit once done).
2. `src/app/api/quote/route.ts` (~:232) — the price dispatch: `serviceType === 'permanent' ? … : serviceType === 'event' ? … : calculateQuote()`. **Both edit the same line.**
3. `src/lib/quoteForm.ts` — `QuoteFormData` gains a per-vertical block + build/hydrate branches.
4. `src/components/quote/QuoteBuilder.tsx` — the service-type picker section switch (which section set renders).
5. `src/lib/portal/adapter.ts` — the `derivePackages*` dispatch + `service_type` handling + the generalized `minimumOrderSubtotal`.
6. `src/lib/portal/loader.ts` — `service_type` added to the SELECT (permanent adds it; event reuses).
7. `src/lib/portal/lineItemKind.ts` — each adds its kind detection.
8. `src/components/portal/types.ts` — each adds a `PortalLineItemKind` union member.
9. `src/app/portal/[quoteId]/page.tsx` — the portal section-list branch on `serviceType`.
10. `src/app/api/quotes/[id]/approve/route.ts` + `amend/route.ts` — each adds a service_type re-price/guard branch (+ the H1/H2/H3 hardening).
11. `src/lib/appSettings.ts` (+ `api/settings/route.ts` + settings page) — `permanentRates` / `permanentEnabled` and `eventRates` / `eventEnabled` (additive, same file).

## Event is NOT a copy of permanent — plan it fresh

Permanent = a permanent **install** (roofline pucks-on-track, $/ft, materials BOM, lifetime warranty, 50% deposit). Event lighting is different — likely **temporary** (festoon/bistro/uplighting for weddings/parties): probably no puck-BOM/inventory, maybe not a $/ft roofline model, different packages, different deposit/terms, possibly a rental/short-term shape. **The event session must run its own brainstorm → plan (same process this one did) before building** — do NOT assume it mirrors permanent. Only the *dispatch seams* are shared; the *model* isn't.

## The strategy — how to run them in parallel

**Rule: one vertical OWNS the dispatch-seam conversion; the other only adds its `case` after.**

Permanent is further along (planned, twice-reviewed), so **permanent owns the seams**. It converts each shared file from holiday-only (`if holiday-else`) into a `service_type`-aware dispatch. Event then adds `case 'event'` to an already-multi-branch switch — a small clean addition, not a rewrite-collision.

Concretely:

1. **Event session, Phase A (parallel NOW, zero conflict):** brainstorm + plan event, then build ALL of event's 🟢 isolated modules — `lib/event/**`, event components, `derivePackagesEvent`, `eventRates` shape. These touch NO shared file. Land them as `naldo/event-*` PRs. Event's engine emits the same `QuoteResult` shape (same contract permanent uses) so the seams stay uniform.

2. **Permanent session:** builds P1–P6, which lands the 🔴 seam conversions (dispatch, adapter, portal branch, approve/amend, quoteForm, QuoteBuilder switch, appSettings).

3. **Event session, Phase B (AFTER permanent's seam PRs merge):** add `case 'event'` to each converted seam. Because permanent already turned each `if/else` into a multi-branch dispatch, event's additions are adjacent, additive, and mostly auto-merge. Re-gate per the never-stale rule.

**If event is URGENT and can't wait for permanent's seams:** land ONE tiny shared scaffold PR first — a `priceByServiceType(inputs)` dispatch + the `service_type` plumbing (loader SELECT, portal branch stub, adapter dispatch) with holiday default and empty permanent/event cases — then BOTH verticals fill their case in isolation. Costs a day up front; removes all seam collisions. Only worth it if truly simultaneous.

## Guardrails (both sessions)
- **Branches:** `naldo/permanent-*` and `naldo/event-*`. Never both editing a 🔴 file on unmerged branches at the same time — coordinate which lands first, then the other rebases + re-gates (never-stale).
- **All 🔴 files are JASON's area** (pricing/portal/quote/settings) — both PRs flag Jason.
- **Contract discipline:** both engines MUST emit a complete `QuoteResult` (same shape holiday does) so the shared adapter/approve/amend code branches on `service_type` but never special-cases beyond the dispatch. Keep vertical-specific logic in `lib/permanent/**` / `lib/event/**`.
- **Feature flags** keep both dark until their portal lands: `permanentEnabled`, `eventEnabled` (default false).
- **Don't double-edit `appSettings.ts`/`portal/types.ts` on two live branches** — they're small additive files but the same lines; whichever merges 2nd re-syncs.

## Kickoff prompt for the event session (paste into the new session)

> New session, Naldo. Plan + build the **EVENT LIGHTING** service vertical (`service_type='event'`), to run IN PARALLEL with the permanent-lighting build (plan: `docs/superpowers/plans/2026-07-02-permanent-lighting-vertical.md`, PR #332). READ FIRST: that permanent plan + `docs/superpowers/plans/permanent-event-parallel-coordination.md` (the conflict map). Event is temporary event lighting (festoon/bistro/uplighting) — a DIFFERENT model from permanent; brainstorm + plan it fresh (its pricing, packages, deposit/terms, and whether it needs any inventory/BOM at all — likely not). CRITICAL parallel-build rule from the coordination doc: build ALL of event's ISOLATED modules first (`src/lib/event/**`, event portal components, `derivePackagesEvent`, event settings) — these never conflict with permanent. Do NOT touch the shared dispatch seams (`pricingEngine.ts`, `/api/quote/route.ts`, `QuoteBuilder.tsx`, `portal/adapter.ts`, `portal/[quoteId]/page.tsx`, approve/amend routes, `quoteForm.ts`, `appSettings.ts`) until the permanent build has converted them to `service_type` dispatch — then just add `case 'event'`. Branch `naldo/event-*`; flag Jason (his area); never merge stale. Same execution policy as AGENTS.md (model routing + prod guardrails).
