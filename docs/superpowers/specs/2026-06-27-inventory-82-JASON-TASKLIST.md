# Inventory #82 — Full task list for Jason (handoff from Naldo, 2026-06-27)

> **Naldo has shipped the entire Naldo-lane half of the Inventory epic** (Slice 1 + the per-unit materials engine + the materials view — all merged to `master`). What remains all touches **your area or the shared scene/editor-core/`jobs` entity**, so it's handed to you. This is the prioritized, actionable list. Detail for the biggest item (the roof-feature relay) is in `docs/superpowers/specs/2026-06-27-inventory-82-slice2b-jason-heads-up.md`. Decision-locked design: `docs/superpowers/specs/2026-06-27-inventory-82-design.md`.

## ✅ Done + merged (Naldo's lane — context, not tasks)
- **1a Catalog** — `inventory_catalog` table + Thunder CSV parser + `catalog.ts` + `GET/POST /api/inventory/catalog` (831 Thunder SKUs + 9 YLL Decoration-Fee items `1101–1109` imported to prod).
- **1b Bindings** — `concepts.ts` (the design-concept→SKU vocabulary + key-builders, the single source of truth), `bindings.ts` (`app_settings` `bindings`+`clipRules`) + `GET/PUT /api/inventory/bindings`; the **binding editor** `/inventory/bindings` (searchable SKU picker; C9+Bistro bulbs, catalog-derived Mini Lights, per-size wreath/garland base+bow+decoration-fee, spritzer color×size+pole, pre-filled clip rules) + **overrides** `/inventory/overrides` (category show/hide + sold-out item lock). **Naldo's autofill-default bindings are SAVED on prod** (47 bindings + 6 clip rules).
- **1c On-Hand** — `inventory_on_hand` table (migration applied) + `onHand.ts` + `GET/PUT/DELETE /api/inventory/on-hand`; the warehouse stock table at `/inventory` (Stock).
- **2a Materials engine (per-unit)** — `materialsProjection.ts`: `projectMaterials(scene, bindings)` → `{sku, qty}` for wreaths/garland/spritzers/minis (a pure parallel of `projectScene.ts`), `aggregateMaterials`, `buildMaterialsView` (joins catalog name + on-hand). Reuses the `concepts.ts` key-builders. **Wreath bow ships on both tiers; fee Decorated-only; garland bow Decorated-only** (Naldo-confirmed).
- **2d Materials view** — `/inventory/materials` + `GET /api/inventory/materials?quote=<id>`: pick a quote → its design's projected materials with on-hand status + unbound flags.

---

## 🔴 YOUR TASKS (priority order)

### 0. PREREQUISITE — `#81` operator-auth perimeter
Both #82 Slice 3 and your Jobber-flow #83 are gated on it. The dormant default-deny middleware exists (`src/middleware.ts`, `AUTH_GATE_ENABLED`). Land #81 so the whole operator surface (incl. all `/inventory/*` + the new APIs) is gated at once. Until then the inventory pages are operator-only by intent but ungated.

### 1. Slice 2b — Roof-feature tag (SHARED + EDITOR-CORE RELAY) — *the unblocker*
This is the one shared edit everything else in 2b waits on. **Full detail: the slice2b-jason-heads-up doc.** Summary:
- **a.** Add an additive+optional `roofFeature?: RoofFeature` to `StrandItem` in `src/lib/design/sceneTypes.ts` — `'gutter'|'peak'|'side'|'ridge'|'pathway'|'flat'|'metal'`.
- **b.** A "Roof feature" dropdown in `src/components/design/editor-core/editor.ts` (~`:2294-2317`, where `surface` is set) to set it per roofline run. UI hard-rules: no window lighting, no C7 clips; metal → flag for staff.
- **c.** **Byte-identical relay** to the standalone design tool (`C:\Users\Jason\Desktop\YuleLoveLights\Claude`) — mirror (a)+(b), same discipline as #63/#71/#73, in the same PR.
- Ship as its own small PR (SHARED → Naldo reviews; relay included). **Then Naldo builds 2b's engine on top (his lane, no further shared edit):** `clipRules.ts` (roof-feature + footage + the `clipRules` config → clip SKU + count) + bulbs/wire/clips in `materialsProjection.ts` (footage from `QuoteInputs`, per-run feature from the new tag). *Tell Naldo when (a)–(c) land, or hand him the relay to draft for your review.*

### 2. Slice 2c — AI auto-detect of the roof feature
Extend the `#8` photoAnalysis (`src/lib/photoAnalysis.ts`) to auto-detect each run's roof feature (gutter/peak/side/ridge/…); staff verify/correct in the editor; corrections feed the existing **#8 training** loop. Depends on Task 1 (the attribute must exist). Your area (AI/training).

### 3. Slice 3 — Jobs + Kanban (SHARED `jobs` entity with #83)
- **a.** **Align ONE `jobs` schema with Jobber-flow #83 FIRST** (Job ID ≠ Quote ID; auto-created on the deposit-paid `#38` Valor webhook). Inventory adds the operational **Stages-Kanban** fields (To-Be-Ordered → Awaiting-Pickup → To-Be-Prepared → Ready-For-Install); #83 adds billing statuses + the invoice link. **Build ONE object — do not duplicate.** See `docs/jobber-flow/SPEC.md`.
- **b.** `jobs` table + `jobs.ts` + auto-create on the deposit-paid webhook, carrying the work order (customer/address/job-type + design + satellite + **the materials list — already projectable via `buildMaterialsView`**).
- **c.** Stages Kanban on `/inventory` (cards = jobs; a different board from the dashboard's Quotes WorkflowBoard).
- **d.** PDF/email order export (the materials projection joined to on-hand — the join helper already exists).
- Gated on #81 (Task 0) + the #83 align.

### 4. Phase 2/3 (later) — stock loop + automation
Job-needs-vs-on-hand comparison → order-vs-prepare; **decrement on prep** (Naldo-confirmed timing); low-stock/reorder alerts. Then the WhatsApp bot + AI auto-ordering (heaviest, most external — deferred).

---

## Hooks Naldo already built that you'll reuse
- **Materials list for any quote/job:** `projectMaterials(scene, bindings)` + `buildMaterialsView(lines, nameOf, onHandOf)` in `src/lib/inventory/materialsProjection.ts` → ready to drop onto a job's work order (Task 3b/3d).
- **Clip config:** the `clipRules` `app_settings` key (roof-feature → `{sku, perFt}`) is already editable in the binding editor (pre-filled with the known clip SKUs) — `clipRules.ts` just reads it once the roof-feature tag (Task 1) lands.
- **Concept vocabulary + keys:** `src/lib/inventory/concepts.ts` is the single source of truth for binding keys — the materials engine and the editor must agree through it.

## Open business-rule notes (Naldo answered; recorded so they're not re-litigated)
- Wreath bow ships on **both** tiers; wreath fee + garland bow + garland fee are **Decorated-only**.
- Spritzer poles + C9 bulbs + Bistro are intentionally **not autofilled** — Naldo binds those by hand on `/inventory/bindings`.
- Permanent bulbs were removed from the binding editor → ledger **#88** (Permanent Lighting), a future feature pairing with #85 (Glow365 recurring).
