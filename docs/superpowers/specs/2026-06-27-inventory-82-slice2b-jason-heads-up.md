# Inventory #82 — Slice 2b: Jason coordination heads-up (roof-feature tag + relay)

> **From Naldo's side (2026-06-27).** Slice 2a (per-unit materials projector) shipped in PR #195 — wreaths/garland/spritzers/minis → `{sku, qty}` from the bindings, entirely Naldo's lane. **Slice 2b is the roofline half, and it needs a SHARED scene/editor-core change that's Jason's area + a byte-identical relay to the standalone design tool.** This doc is the heads-up so we align before either side edits the shared files (per AGENTS.md "SHARED-file PRs: the other owner reviews first").

## Why 2b needs a shared edit
The clip-rules engine maps a roof **feature** (gutterline / peak / side / ridge / pathway / flat / metal) → the right clip SKU + count. **No physical roof-feature attribute exists on the scene today** — the `surface` tag (`santas-roofline` / `gingerbread` / `winter-wonderland` / `stake-lighting`) is a *billing* category, NOT the physical feature the clip logic needs (confirmed `sceneTypes.ts:75-100`). So clips can't be projected until each roofline run carries its physical feature.

## The shared edit (Jason's area + EDITOR-CORE RELAY)
1. **`StrandItem` gets an additive + optional `roofFeature`** in `src/lib/design/sceneTypes.ts` (alongside the other binding additions ~`:75-107`):
   ```ts
   export type RoofFeature = 'gutter' | 'peak' | 'side' | 'ridge' | 'pathway' | 'flat' | 'metal';
   // on StrandItem:  roofFeature?: RoofFeature | null;  // physical clip feature (NET-NEW, #82 2b)
   ```
   Additive + optional → the core geometry stays byte-identical; existing/design-tool data without it is just "unset".
2. **A "Roof feature" dropdown** in the editor's strand/quote-binding panel (`src/components/design/editor-core/editor.ts` ~`:2294-2317`, where `surface` etc. are set) so staff pick the feature per run. (Hard rules to encode in the UI copy: no window lighting, no C7 clips; metal → flag for staff, no clip.)
3. **Byte-identical relay to the standalone design tool** — mirror the `sceneTypes` addition + the editor dropdown into the design tool repo (`C:\Users\Jason\Desktop\YuleLoveLights\Claude`), same discipline as #63/#71/#73. Ship the relay in the same change.

## What Naldo builds on top (YLL-only — NO relay)
- **`src/lib/inventory/clipRules.ts`** — pure engine: `roofFeature` + footage + the `clipRules` config (already built/stored in 1b) → `{ sku, qty }` (qty = footage × clips-per-ft). Metal → no clip (staff flag).
- **Roofline materials in `materialsProjection.ts`** — bulbs (footage ÷ spacing × color binding) + wire (footage) + clips (the clip engine). Footage source = the staff-entered `QuoteInputs` (authoritative for billing); the clip engine reads the per-run `roofFeature`.
- These read the new attribute but don't change it — so once Jason's shared edit lands, Naldo wires the engine with no further shared edits.

## Sequencing ask
- **Jason:** when you have a window, do the shared edit (steps 1–3) as its own small PR (SHARED → Naldo reviews; relay in the same change). Or tell Naldo to draft it for your review. Either works — we just need the `roofFeature` field + dropdown + relay agreed before 2b's engine can project clips.
- **AI auto-detect (Slice 2c)** of the roof feature extends the #8 photoAnalysis (staff verify/correct → feeds #8 training). Jason's area; comes after 2b.

## References
- Design spec: `docs/superpowers/specs/2026-06-27-inventory-82-design.md` (§4 clip table, §6 Clips row, §8 Slice 2).
- 2a spec/PR: `docs/superpowers/specs/2026-06-27-inventory-82-slice2a-materials.md` · PR #195.
- The clip-rules config (`clipRules` app_settings key) + the binding editor's pre-filled clip SKUs already exist (Slice 1b).
