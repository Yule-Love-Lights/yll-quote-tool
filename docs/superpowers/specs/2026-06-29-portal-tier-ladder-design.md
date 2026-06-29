# Portal package tiers — coverage-based ladder redesign

> Status: DRAFT for review (Naldo + Jason). 2026-06-29.
> Area: `src/lib/portal/derivePackages.ts` (Jason's pricing/portal area). Pure functions, no DB/migration.

## Problem

The portal auto-derives up to four tappable "packages" (Tier 1/2/3 + Custom) from a
single quote's line items (`derivePackages.ts`). Today's rules make the tiers
collapse together on common quotes:

- **Tier 1 (Classic Glow)** = Santa's roofline + the cheapest items needed to clear
  the $1,000 minimum. On a modest quote this grabs **every** item just to reach $1k.
- **Tier 2 (Full Festive)** = Tier 1's *exact item set* with Santa's roofline swapped
  for Gingerbread. So it differs from Tier 1 by **only the roofline price**.
- **Tier 3 (The Full Yule)** = everything, on Gingerbread.

Because Tier 1 already pulls in every item on a modest quote, **Tier 2 and Tier 3
come out byte-identical** — the customer sees two cards with the same price and the
same contents. There is a de-dupe guard for Tier 2-vs-Tier 1, but none for
Tier 2-vs-Tier 3.

### Observed (real quote `c26cdb75…`)

Items: Santa's roofline $320, Gingerbread $840, 3× bush $70, 1× bush $105,
3× spritzer $95, 1× wreath $285 (no trees/garland/columns/railings).

| Card | Price (tax-in) | Contents |
|---|---|---|
| Tier 1 — Classic Glow | $1,310.44 | Santa's + all extras |
| Tier 2 — Full Festive | **$1,875.94** | Gingerbread + all extras |
| Tier 3 — The Full Yule | **$1,875.94** | Gingerbread + all extras — **identical to Tier 2** |

## Goal

Make the tiers a genuine good/better/best **by coverage** — "how much of your home is
lit" — that are always meaningfully different, and never show two duplicate cards.
When a quote is genuinely too small to support three distinct levels, show fewer
distinct cards (plus Custom) rather than padding a fake third tier.

## Decisions (locked with Naldo)

1. **Model:** good/better/best by **coverage**.
2. **Roofline:** Santa's (front edge) anchors Tier 1; Gingerbread (front + ridge +
   sides) anchors Tier 2 & Tier 3. The Tier 1 → Tier 2 step upgrades the roofline.
3. **Accent split (Balanced — Naldo's default; freely adjustable):**
   - **Accents** (enter at Tier 2): bush, spritzer, wreath, stake-lighting (pathway),
     ridge.
   - **Showpieces** (enter at Tier 3): tree, garland, column, railing, bow.
4. **Small quotes:** showing **2 distinct cards + Custom** (instead of a forced thin
   third) is acceptable.

## Design

### Element buckets (by line-item `kind`)

```
ROOFLINE   : roofline (Santa's id, Gingerbread id)
ACCENTS    : bush, spritzer, wreath, stake-lighting, ridge
SHOWPIECES : tree, garland, column, railing, bow
```

Unknown/other kinds default to **SHOWPIECE** (they appear only in the full tier, so a
new element type never silently lands in the middle tier before it's classified).
The exact kind→bucket map is a single named constant so Naldo can move items later
without touching logic.

### The cards

| Card | Contents | Story |
|---|---|---|
| **Tier 1 — Classic Glow** | Santa's roofline + cheapest **accents** needed to clear the $1,000 gate | The clean outline |
| **Tier 2 — Full Festive** | Gingerbread roofline + **all accents** (no showpieces) | The fuller look |
| **Tier 3 — The Full Yule** | Gingerbread + **everything** (accents + showpieces) | The whole design |
| **Custom / Our Recommendation** | unchanged (staff-recommended set, or empty "Build Your Own") | Build your own |

### The structural fix

The defect is that today Tier 2 is "Tier 1 + roofline swap" and Tier 3 is
"everything," so they converge. The new rule decouples them:

- **Tier 2 = roofline + accents only** (explicitly **excludes** showpieces).
- **Tier 3 = everything.**

So **Tier 2 ≠ Tier 3 whenever the quote contains any showpiece.** When it doesn't,
the spacing guarantee (below) drops the duplicate instead of showing it twice.

### $1,000 gate handling (Tier 1 must be approvable)

Tier 1 starts as Santa's roofline alone. If that's below the $1,000 minimum, top it up
with the **cheapest accents first** until it clears the gate — accents only, so
Tier 1 ⊆ Tier 2 (the coverage story stays nested). If even *all* accents can't reach
$1,000, Tier 1 stays as-is (Santa's + all accents) and the existing approval gate
shows the customer "add $X to approve"; the spacing guarantee will usually collapse
it against Tier 2 anyway. Sub-$1,000 whole quotes keep the existing waiver (gate = 0).

### Spacing guarantee (no duplicate cards)

After building the three raw tiers:

1. **De-dupe by item set:** if two tiers resolve to the same set of line-item ids,
   keep the *lower* one and drop the higher (e.g. no showpieces → Tier 3 == Tier 2 →
   drop Tier 3). This is the core fix.
2. **Optional near-dupe collapse (tunable, default off):** a single
   `TIER_MIN_GAP_PCT` constant. When > 0, also drop a tier whose total is within that
   percentage of the tier below it. Default `0` (exact-set de-dupe only) so behavior
   is predictable; Naldo can raise it later if near-identical prices still feel weak.
3. Always keep **Custom (D)**.

The portal already numbers visible tiers by **position** ("Tier 1/2/3"), so dropping a
card renumbers the rest automatically — no separate renumber step.

### What does NOT change

- How selecting a package works downstream (`SelectionContext.selectPackage` still
  replaces the selection with the card's `includedItemIds`; pricing still derives from
  the selected items via `priceSelection`; the live design still hides deselected scene
  items). Only **which items each card contains** changes.
- The **Custom / "Our Recommendation"** card and `applyOurRecommendation` (#12) are
  untouched.
- Tier **names** stay Classic Glow / Full Festive / The Full Yule (renamable; they're
  just labels).
- Per-package totals are still priced with the staff-default rush/takedown state via
  the existing `chargesFromResult` / `effectiveCharges` / `totalsFor` helpers.

## Worked example (the real quote above, after the change)

No showpieces, so Tier 3 == Tier 2 and de-dupes away:

| Card | Price | Contents |
|---|---|---|
| Tier 1 — Classic Glow | $1,310.44 | Santa's roofline + accents |
| Tier 2 — Full Festive | $1,875.94 | Gingerbread roofline + accents |
| Custom | You pick | — |

Two genuinely different cards instead of the duplicate $1,875.94 pair. A richer quote
(with trees/garland/columns) keeps all three distinct.

## Edge cases

- **No distinct Gingerbread roofline** (legacy/single-roofline quotes): use the one
  roofline for every tier; the roofline-upgrade step disappears but the
  accents→showpieces coverage steps remain. De-dupe handles any collapse.
- **Roofline only** (no accents/showpieces): all tiers equal → collapse to one card +
  Custom.
- **Only roofline + accents** (no showpieces): Tier 3 == Tier 2 → two cards + Custom
  (the worked example).
- **Sub-$1,000 whole quote:** gate already waives; tiers build and de-dupe normally.

## Components / structure

All within `derivePackages.ts`, kept as small pure functions:

- `KIND_BUCKET: Record<PortalLineItemKind, 'accent' | 'showpiece'>` — the single
  editable kind→bucket map (roofline handled separately via the existing stable ids).
- `classifyItems(lineItems, rooflineIds)` → `{ accents: id[]; showpieces: id[] }`.
- `buildCoverageTiers(lineItems, rooflineIds, threshold)` → the raw Tier 1/2/3 id sets
  (replaces `buildEntryTier`'s "grab everything to $1k" role).
- `dedupeTiers(tiers, minGapPct)` → distinct tiers in order.
- `derivePackages(...)` — unchanged signature; rewired to the above, then appends
  Custom (D) as today.

## Testing (TDD)

Pure functions → unit tests in `derivePackages.test.ts`:

- A rich quote (roofline pair + accents + showpieces) → three distinct tiers with the
  expected item sets and ascending totals.
- The real-quote shape (no showpieces) → exactly two distinct tiers + Custom; assert
  Tier 3 is dropped, not duplicated.
- Roofline-only quote → one card + Custom.
- No-distinct-Gingerbread (single roofline) → tiers still build and de-dupe.
- Tier 1 top-up: a quote where Santa's < $1k → Tier 1 reaches the gate using accents
  only and stays ⊆ Tier 2.
- `KIND_BUCKET` mapping: each accent kind lands in Tier 2; each showpiece kind only in
  Tier 3.
- Totals: each tier's total equals `priceSelection` over its item set (parity with
  the live `SelectionContext` total).

## Scope & ownership

- One file: `src/lib/portal/derivePackages.ts` (+ its test). **Jason's pricing/portal
  area** — his review before merge.
- Pure functions; **no DB change, no migration, no API change.** Downstream selection
  and pricing are untouched.

## Open / tunable

- `TIER_MIN_GAP_PCT` default (start at `0` = exact-set de-dupe; revisit if near-equal
  prices still read as "the same").
- The `KIND_BUCKET` split is Naldo's to tune (e.g. move wreath/garland between accents
  and showpieces) without code changes.
- Tier names / taglines (cosmetic).
