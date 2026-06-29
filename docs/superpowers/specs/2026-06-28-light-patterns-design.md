# Official light PATTERNS — customer-selectable, inventory-aware (#92)

**Status:** ✅ DESIGN APPROVED + REVISED (Jason, S15 · 2026-06-29) — BUILDING. The **Revised design** section directly below SUPERSEDES the original spec (kept beneath it for history) wherever they differ. **Owner: Jason** (coordinate the inventory-projection edits with Naldo).
**Date:** 2026-06-28 (Naldo directed) → revised 2026-06-29 (Jason + Claude). **Pricing/area:** no pricing-engine change.

---

## ✅ Revised design (Jason S15, 2026-06-29) — what we're actually building

The original spec added the 9 patterns as **portal swatches**. Jason's revision: **do NOT add swatches** (the picker already has enough buttons). Instead the patterns work **behind the scenes** — we match the colors the customer *ends up with* to our real strands, and we make both the **portal design** and the **staff materials order** reflect only **what we can actually supply**.

### Trigger & matching
- Look at the customer's **effective colors** — from **Build-your-own**, an existing **named swatch**, or **As-designed** (the operator's per-item colors) — and **match by color SET, order-ignored**, against the known pattern signatures. No new swatches.
- **The one portal-swatch change:** rename **"Blue & White" → "Frozen"** (label only; keep the id `blue-white` so saved quotes don't break). That swatch maps to the Frozen strand.

### The shared "install resolver" (one source of truth)
A pure function decides, per mini/spritzer item, what gets installed. **Both the portal render AND the materials projection consume it**, so the picture and the order never disagree.

| Effective colors for an item | Result (render + order) |
|---|---|
| Matches a known pattern, strand exists for this product (+ size, spritzers) | **The strand** — render intermixed, order the strand SKU × count |
| Matches a pattern with **no strand for this product** (Ocean/Wintergreen/Grinch/Rockefeller/Goblin spritzers) | **Round-robin** the offered colors across the items, one solid each |
| **No pattern match** (e.g. red+blue+pink) | **Round-robin** across items, one solid each |
| A color **not offered** for this item type | Dropped from the round-robin; if **none** are offered → fall back to the item's **as-designed** color |

- **"Offered colors" = the live inventory bindings.** Minis offer 11 palette colors; spritzers offer 6 (no orange/yellow/purple/teal; 32" only in warm/pure white). Read from `getInventoryBindings()` so it auto-updates if a color is bound later.
- **Round-robin** = one solid color per item, cycling in scene order, **separately per product type**. (Ocean spritzers, teal not offered → cycle blue/pure-white: 1→blue; 2→blue,white; 3→blue,white,blue; …) Minis with the Ocean strand just order the strand × count.
- **Whole-house pick** (Build-your-own / named) → round-robin spreads it across items. **As-designed** → each item keeps its own authored color (no shuffle).
- **C9 roofline is untouched** — every color is an individually-placed C9 bulb, so it's always installable/intermixed. The render change is **minis & spritzers only**.

### Portal render change (the screenshot fix)
Today the render cycles every color through *each* item (one bush shows all colors mixed). Change it to **one solid color per item** (round-robin) for the **no-strand** case; **matched strands stay intermixed** (a Grinch strand really is red/green/white woven together); C9 roofline unchanged.

### Fulfillability gate (operator side only)
Staff don't know what's stocked, so we **catch un-fulfillable items before send** rather than constrain the editor palette (constraining the picker = an editor-core change + design-tool relay, and can't catch the pattern case — rejected).
- Flag any item we **can't supply as drawn**: (a) a **color we don't offer** for that type (orange spritzer), or (b) a **single item drawn as a multi-color mix that isn't a stocked strand**. In practice this only trips on **minis & spritzers**.
- Surface as **red text per item in "From your design"** + **a red line by the Send button** + **block Send** until fixed (mirrors the existing garland-warning / $1,000-gate patterns).
- **Customer is never blocked** — on the portal we **silently filter** their pick to what we offer (falling back to the operator's as-designed color, which the gate guarantees is fulfillable). Only the operator is gated.

### Slices (separate PRs, TDD, no migration, **no editor-core change → no relay**)
1. **Foundations** (this PR): `inventory/patternSkus.ts` (13 pattern signatures + SKUs) + `inventory/resolveInstalls.ts` (the resolver + offered-from-bindings) + tests. Pure libs, staff-side.
2. **Inventory projection** consumes the resolver (`materialsProjection.ts` + thread `colorSchemeId`/`customPattern` from the snapshot at the 3 call sites: `jobs.ts`, materials `route.ts`, `purchaseOrder.ts`).
3. **Portal render** consumes the resolver (customer-facing → adversarial review + Jason's go) + the Blue&White→Frozen rename.
4. **Fulfillability gate** (`detectUnfulfillable.ts` + red flags in `DesignSummary.tsx` + banner/Send-block in `QuoteBuilder.tsx`).

Suggested order: 1 → 2 → 4 → 3 (customer-facing render last). Naldo gets a heads-up before Slice 2 (his inventory files).

### The 13 pattern signatures (set → SKUs; all verified against `concepts.ts`)
`multicolor`{red,green,blue,yellow,pink} 40256 / 61201·61202 · `champagne`{warm-white,cool-white} 43096 / 61011·61012 · `candy-cane`{cool-white,red} 43136 / 61131·61132 · `christmas`{green,red} 43436 / 61341·61342 · `blue-white`(Frozen){blue,cool-white} 43156 / 61151·61152 · `ocean`{teal,blue,cool-white} 43556 / — · `wintergreen`{blue,green,cool-white} 43456 / — · `patriot`{red,cool-white,blue} 43356 / 61351·61352 · `grinch`{red,green,cool-white} 43346 / — · `rockefeller`{red,blue,green,orange,yellow} 43226 / — · `old-fashioned-candy-cane`{warm-white,red} 43036 / 61031·61032 · `goblin`{purple,green} 43756 / — · `halloween`{purple,orange} 43656 / 61671·61672. (Spritzer strands are 16″/24″ only — never 32″.)

---

## The idea (Naldo) — ORIGINAL SPEC BELOW (historical; superseded above where they differ)
We have two disconnected notions of "pattern":
1. **Render side** — `src/lib/design/colorSchemes.ts` already has customer-facing schemes (Multicolor, Champagne, Candy Cane, Christmas, Blue & White) that are just **color-id sequences** the portal recolors the live design with. They have **zero inventory effect**.
2. **Inventory side** — the supplier actually sells **pattern STRANDS** for mini lights & spritzers (Grinch, Ocean, Frozen, Wintergreen, Patriot, Rockefeller, Goblin, …), each a real SKU. These are the curated mini/spritzer names added in the #82 binding work (`MINI_LIGHTS` / `SPRITZERS` in `src/lib/inventory/concepts.ts`).

**Goal:** make "pattern" one first-class thing — the customer picks a pattern on the portal and the system **automatically derives the correct supplier strand (inventory)**, in addition to recoloring the design. Patterns apply to **mini lights & spritzers only** (NOT roofline C9s — no C9 pattern strand exists).

### The gap this closes
- Today the materials projection (`materialsProjection.ts`) orders minis/spritzers by their **first solid color** (`colorPattern[0]`). A "Grinch" mini-area (a multi-color cycle) would order a plain **Red** strand, not a Grinch strand.
- The customer's portal scheme pick is a **render override** frozen in `approval_snapshot.customerSelection.colorSchemeId`; it **never reaches the staff materials list** (the projection reads the design scene, not the customer's choice).

## Locked decisions (don't re-ask)
1. **Selection model = WHOLE-HOUSE, customer-picks on the portal.** Extends the existing portal color-scheme picker. The customer selects ONE pattern; every mini/spritzer that can be that pattern orders that strand. (NOT per-item; per-item is out of scope / future.)
2. **No price change.** A pattern changes the look (render) and which strand staff orders (inventory) only. The customer price stays driven by strand count / per-spritzer. No pricing-engine work.
3. **Missing-strand fallback = BUILD FROM SOLIDS.** When a chosen pattern has a strand for one product type but not another (e.g. a Grinch MINI strand exists but no Grinch SPRITZER), the product type without a strand is **decomposed into solid strands** approximating the pattern's colors (e.g. Grinch spritzers → red + green + pure-white solids).

## Architecture (well-scoped — selection/render/snapshot already exist)
The **selection + render + snapshot** machinery is already built (`colorSchemes.ts` + the portal picker + `customerSelection.colorSchemeId` in the approval snapshot). The new work is three pieces:

### A. Extend the pattern definitions (render) — `src/lib/design/colorSchemes.ts`
Add the 9 new patterns as `ColorScheme` entries (id, label, `colorIds` sequence). Existing-pattern sequences stay as-is. New patterns auto-appear in the portal picker (it renders all `COLOR_SCHEMES`). The strobe/pulse effects on some strands (Grinch "w/ PW strobe", Goblin "w/ purple pulse") can't be rendered — approximate with the base colors; note in UI copy if needed.

### B. NEW pattern→SKU map — `src/lib/inventory/patternSkus.ts` (inventory domain, keeps colorSchemes render-only)
```ts
type PatternSkus = {
  miniSku?: string;                                  // the manufactured mini strand, if one exists
  spritzerSku?: { '16'?: string; '24'?: string; '32'?: string }; // manufactured spritzer strand(s), if any
  // fallback colors when a product type has no strand → decompose into solids.
  // Defaults to the scheme's colorIds; override only if the strand's real colors differ from the render cycle.
  fallbackColorIds?: string[];
};
export const PATTERN_SKUS: Record<string /* colorScheme id */, PatternSkus> = { ... };
```
Keyed by the existing `colorScheme` id so the render scheme and the inventory mapping share one identity.

### C. Make the materials projection PATTERN-AWARE — `materialsProjection.ts` / `buildMaterialsView`
The materials view for a job already loads the design scene + bindings. It must also take the **approved pattern** (`colorSchemeId` from the quote's `approval_snapshot`) and, for each mini/spritzer line:
- **Pattern has a strand for this product type** → order that strand SKU (overrides the per-color binding).
- **Pattern has NO strand for this product type** → build-from-solids: emit one solid line per `fallbackColorIds` color (each via the existing `mini:<label>` / `spritzer:<paletteId>:<size>` binding), splitting the strand count across the colors (reuse the existing per-color split logic).
- **`as-designed` / a plain solid scheme / build-your-own custom** → current behavior (order by the item's authored color; custom → its solids).
Quantities/price are unchanged — this only changes WHICH SKU each line resolves to.

### D. Portal polish (small)
The new patterns appear automatically. Optionally group "Patterns" vs solid colors in the picker and/or add a small "pattern" affordance. No snapshot/data change (rides the existing `colorSchemeId`).

## Pattern catalog (proposed mappings — ⚠️ Naldo to confirm the flagged rows)
SKUs from the #82 catalog (`MINI_LIGHTS` / `SPRITZERS`). Render `colorIds` are palette ids from `editor-core/colors.ts`.

| Pattern | Render colorIds | Mini SKU | Spritzer SKU (16/24/32) | Fallback solids |
|---|---|---|---|---|
| Multicolor | red,green,blue,yellow,pink | 40256 | 61201 / 61202 / — | colorIds |
| Champagne | warm-white,cool-white | 43096 | 61011 / 61012 / — | warm-white,cool-white |
| Candy Cane | cool-white,red | 43136 | 61131 / 61132 / — | cool-white,red |
| Christmas | green,red | 43436 (Red/Green) | 61341 / 61342 / — | green,red |
| Blue & White | blue,cool-white | 43156 † | 61151 / 61152 / — | blue,cool-white |
| Ocean | teal,blue,cool-white | 43556 | — (solids) | teal,blue,cool-white |
| Wintergreen | blue,green,cool-white | 43456 | — (solids) | blue,green,cool-white |
| Patriot | red,cool-white,blue | 43356 | 61351 / 61352 / — | red,cool-white,blue |
| Grinch | red,green,cool-white | 43346 | — (solids) | red,green,cool-white |
| Rockefeller | red,blue,green,orange,yellow | 43226 | — (solids) | red,blue,green,orange,yellow |
| Frozen | cool-white,blue | 43156 † | 61151 / 61152 / — | cool-white,blue |
| Old Fashioned Candy Cane | warm-white,red | 43036 | 61031 / 61032 / — | warm-white,red |
| Goblin | purple,green | 43756 | — (solids) | purple,green |
| Halloween | purple,orange | 43656 | 61671 / 61672 / — | purple,orange |

**† Blue & White and Frozen are the SAME physical blue/white strand** — the catalog has exactly one blue/white mini (`43156`, named "Frozen — Pure White/Blue") and one blue/white spritzer (`61151`/`61152`, "Pure White and Blue"). Both patterns map to those SKUs (two render names, one product). Naldo confirmed (2026-06-28) Blue & White maps to a real mini + spritzer, NOT build-from-solids.

**Note: "Green" is NOT a pattern** — Naldo confirmed it stays a plain solid color (already available in the design palette + build-your-own), so it is intentionally excluded from the pattern list. That leaves **9 new patterns** (Ocean, Wintergreen, Patriot, Grinch, Rockefeller, Frozen, Old Fashioned Candy Cane, Goblin, Halloween) + the 5 existing = **14 patterns**.

## ✅ Open items — RESOLVED (Naldo confirmed 2026-06-28)
1. **Frozen vs Blue & White** — both map to the same blue/white strand: mini `43156` + spritzer `61151`/`61152` (the catalog has exactly one of each). Two render names, one product. Neither builds-from-solids.
2. **Christmas mini** → use the **Red/Green** mini (`43436`).
3. **Champagne / Candy Cane spritzers** → confirmed: Champagne = `61011`/`61012`, Candy Cane = `61131`/`61132`.
4. **"Green"** → leave as a plain **solid** (NOT a pattern). Excluded from the pattern list.

No open data items remain — the catalog above is build-ready.

## Out of scope (YAGNI)
- Per-item patterns in the design editor (staff assigning Grinch to one bush) — whole-house only for v1.
- Any pricing-engine impact.
- Roofline C9 patterns.
- Rendering true strobe/pulse animation.

## Testing
- `colorSchemes.test.ts`: every new pattern's `colorIds` reference valid palette ids (existing test pattern).
- `patternSkus` unit test: every referenced SKU exists in `MINI_LIGHTS`/`SPRITZERS`; every pattern id is a known `colorScheme` id.
- Materials-projection tests: (a) pattern with a strand → orders the strand SKU; (b) pattern without a strand → build-from-solids decomposition (right colors, count split); (c) `as-designed`/solid/custom → unchanged.

## Files (anticipated)
`src/lib/design/colorSchemes.ts` (add patterns) · NEW `src/lib/inventory/patternSkus.ts` · `src/lib/inventory/materialsProjection.ts` + `buildMaterialsView` (pattern-aware) · portal picker component (optional grouping) · tests. No migration (rides the existing `colorSchemeId` snapshot field).
