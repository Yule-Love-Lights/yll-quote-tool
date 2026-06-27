# Inventory #82 — Slice 2d: Materials-list view — Design Spec

> **Status:** APPROVED (Naldo, 2026-06-27). Surfaces the materials engine (2a): pick a quote → see its projected materials. Fully Naldo's area — zero relay (reads the shared quotes/designs tables; reading is always fine).

## Goal
A `/inventory/materials` screen where staff pick a saved quote and see the **per-unit materials** its design needs — each SKU with its name, quantity needed, and **on-hand** count — with any **unbound** concepts flagged. Makes the 2a projector visible + useful (sanity-check bindings, see what a design needs) and is the precursor to the job's materials list (Slice 3). Per-unit only for now (roofline bulbs/wire/clips arrive in 2b).

## Design
**Server endpoint** `src/app/api/inventory/materials/route.ts` — `GET ?quote=<id>` does the whole projection server-side and returns a display-ready payload:
1. Scene = the design linked to the quote (`designs.quote_id`, `.scene`; direct service-client query — no `sharp` import).
2. `bindings` = `getInventoryBindings().bindings`.
3. `projectMaterials(scene, bindings)` → lines; `aggregateMaterials` → bound totals.
4. Join: `listCatalog()` (sku → name) + `listOnHand()` (sku → on_hand_qty).
5. Response:
   ```
   { hasDesign, materials: [{ sku, name, qty, onHand: number|null, short: boolean }],
     unbound: [{ conceptKey, label, qty }], totalLines }
   ```
   - `materials` = aggregated bound SKUs, name from catalog, `onHand` from inventory_on_hand (null = not stocked), `short = onHand != null && onHand < qty`.
   - `unbound` = the null-sku lines grouped by `conceptKey` (summed qty + a label) — what staff still need to bind.
   - Service-role gated (503 when unconfigured); 400 on a missing `quote`.

**Page** `src/app/inventory/materials/page.tsx` (+ `InventorySubNav` "Materials" item):
- A **quote selector** — load `/api/quotes`, a searchable list (customer name · total · date), pick one.
- On select → `GET /api/inventory/materials?quote=<id>` → render:
  - **Materials table:** SKU · name · qty needed · on-hand · status (In stock / **Short by N** amber / Not tracked).
  - **Unbound panel:** "⚠ N concepts not bound yet" + the list (so staff know what to bind).
  - States: no design on the quote · no per-unit materials (roofline-only — note 2b) · nothing picked yet.

## Out of scope
Roofline bulbs/wire/clips (2b), per-line design-item drilldown, PDF/email export (Slice 3), editing bindings here (that's `/inventory/bindings`).

## Verification
Vitest for the route's pure aggregation/join helper if extracted; gates green; visual QA against a real quote-with-design on the dev server (prod data). Note: prod bindings are currently empty → the view flags everything unbound until Naldo Saves the bindings on `/inventory/bindings`.
