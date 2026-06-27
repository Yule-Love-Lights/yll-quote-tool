# Inventory #82 — Slice 2a: Per-unit materials projector — Design Spec

> **Status:** APPROVED (Naldo, 2026-06-27). First half of the Materials engine (Slice 2). **Entirely Naldo's area — zero relay.** The roofline half (bulbs/wire/clips + the roof-feature tag + relay to the design tool) is **Slice 2b** (needs Jason coordination); AI auto-detect is 2c.

## Goal
A pure function that turns a design `Scene` + the inventory `bindings` into the **per-unit material lines** — `{sku, qty}` for wreaths (base + bow + decoration fee), garland, spritzers (spritzer + pole), and mini-light wraps. A parallel of `src/lib/design/projectScene.ts` (which turns the same items into *pricing* inputs), but reading the bindings instead. Foundation the job's materials list (Slice 3) builds on.

## Scope
- **In:** wreath / garland / spritzer / mini per-unit materials, from the scene items already carrying billed specs (`quoteSize`/`quoteLength`/`quoteSections`/`tier`/`stringCount`/`colorPattern`). Unbound concepts emit a line with `sku: null` so the list can flag "not bound yet". An aggregator that sums duplicate SKUs into orderable totals.
- **Out (Slice 2b):** roofline bulbs/wire/clips (footage-driven + the NET-NEW roof-feature tag). **Out:** standalone bows (no binding concept exists — flagged, not projected). **Out:** any UI / job wiring (later).

## Design
`src/lib/inventory/materialsProjection.ts` (pure; no Supabase/React):
```
projectMaterials(scene, bindings) -> MaterialLine[]
aggregateMaterials(lines) -> { sku, qty }[]   // sum by sku, drop unbound, sorted
```
- `MaterialLine = { sku: string | null; qty: number; category; conceptKey; label; sceneItemId }`.
- Reuses the **binding key-builders from `concepts.ts`** (`wreathBaseKey`/`wreathBowKey`/`wreathFeeKey`/`garlandBaseKey`/`GARLAND_BOW_KEY`/`GARLAND_FEE_KEY`/`spritzerKey`/`spritzerPoleKey`/`miniKey`) so the projector and the binding editor can never disagree on key format.
- **Per-item rules** (mirrors `projectScene`'s per-unit branches + defaults so materials match pricing):
  - **Wreath** (`quoteSize` def `36noble`, `tier` def `bow`): base `wreath:<size>` ×1 + `wreath-bow:<size>` ×1 (a bow ships with EVERY wreath — both tiers, Naldo); if `fullDecor` also `wreath-fee:<size>` ×1. *(Garland differs — its bow gates on Decorated only, per the "garland has no included bow" pricing rule. CONFIRMED by Naldo.)*
  - **Garland** (`quoteLength` def `9ft`, `quoteSections` def 1, `tier` def `fullDecor`): base `garland:<length>` × sections; if `fullDecor` also `garland-bow` ×1 + `garland-fee` ×1.
  - **Spritzer** (`quoteSize` def `24`, color = `colorPattern[0]` def `warm-white`): `spritzer:<paletteId>:<size>` ×1 + `spritzer-pole:<size>` ×1.
  - **Mini** (strand w/ `surface` tree/bush/column/railing, mini-area, or mini-group; `stringCount` def 1, color = `colorPattern[0]` def `warm-white`): `mini:<catalogColorLabel>` × stringCount. The palette id → catalog color label via `DEFAULT_COLORS` (e.g. `warm-white`→"Warm White", `cool-white`→"Pure White") so it matches the catalog-color-keyed mini bindings. **Grouped strands** (`groupId` set) are skipped (projected via their group, like `projectScene`).
  - Excluded items (`included === false`) skipped. Roofline strands / bows / text / custom / pole → not projected here.
- `aggregateMaterials` sums quantities per non-null sku → `{sku, qty}[]` (orderable totals).

## Verification
- Vitest (TDD): each per-item rule, defaults, unbound → null, excluded/grouped skipped, aggregation. Run the projector against a **real prod design + the autofill-default bindings** to show a concrete materials list.
- Gates: tsc · lint · vitest green. PR; Naldo merges.

## Notes
The projector reads the `bindings` map only (the `clipRules` are Slice 2b). It does not fetch — callers pass the scene + bindings (a thin server caller / Slice-3 job builder wires `getDesign().scene` + `getInventoryBindings().bindings`).
