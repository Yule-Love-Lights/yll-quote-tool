# Portal package tiers — coverage ladder redesign

> Status: DRAFT v2 for review (Naldo + Jason). 2026-06-29.
> Area: `src/lib/portal/derivePackages.ts` (Jason's pricing/portal area). Pure functions, no DB/migration.

## Problem

The portal auto-derives up to four tappable packages (Tier 1/2/3 + Custom) from a
single quote's line items (`derivePackages.ts`). Today's rules make the tiers
collapse together on common quotes:

- **Tier 1 (Classic Glow)** = entry roofline + the cheapest items needed to **cross**
  the $1,000 minimum. The crossing item is *included*, so on a modest quote Tier 1
  grabs an expensive item (e.g. the wreath) and ends up holding **almost everything**.
- **Tier 2 (Full Festive)** = Tier 1's exact item set with the roofline swapped to
  Gingerbread.
- **Tier 3 (The Full Yule)** = everything on Gingerbread.

Because Tier 1 already pulled in nearly every item, **Tier 2 and Tier 3 come out
identical** — same price, same contents. (There's a de-dupe guard for Tier 2-vs-Tier 1,
but none for Tier 2-vs-Tier 3.)

### Observed (real quote `c26cdb75…`)

Items: Santa's roofline $320, Gingerbread $840, 4× bush ($70/$70/$70/$105 = $315),
3× spritzer ($95 = $285), 1× wreath $285. Extras total $885.

| Card | Price (tax-in) | Contents |
|---|---|---|
| Tier 1 — Classic Glow | $1,310.44 | Santa's + **all** extras (the wreath got pulled in to cross $1k) |
| Tier 2 — Full Festive | **$1,875.94** | Gingerbread + all extras |
| Tier 3 — The Full Yule | **$1,875.94** | Gingerbread + all extras — **identical to Tier 2** |

## Goal

Make the tiers a genuine good/better/best by **coverage** ("how much of your home is
lit") that are always meaningfully different, and never show two duplicate cards. The
root fix: **Tier 1 should land near $1,000 with the cheaper items and hold the pricier
items back**, so those pricier items can differentiate the higher tiers.

## Decisions (locked with Naldo)

1. **Model:** good/better/best by **coverage**, built **cheapest-first** (cheap items
   fill the low tier; pricier items step up the ladder). No fixed "accent vs showpiece"
   buckets — the price ordering does the work.
2. **Roofline:** Santa's (front edge) anchors Tier 1; Gingerbread (front + ridge +
   sides) anchors Tiers 2 & 3. The Tier 1 → Tier 2 step upgrades the roofline.
3. **Tier 1 target:** aim for ~$1,000 but **allow only a small overshoot** to include
   the item that crosses the line. If the crossing item is big (e.g. the $285 wreath),
   **hold it back** and let Tier 1 land a little under $1,000 — the customer adds an
   item to approve (the existing gate already nudges "+$X to approve"). Overshoot cap is
   a single tunable, default **15%** ($1,150).
4. **Spacing:** when a quote is genuinely too small to support three distinct levels,
   show **fewer distinct cards + Custom** rather than padding a fake third.

## Design

All within `derivePackages.ts`. The non-roofline line items ("extras") are sorted
**cheapest-first**; the tiers are three cumulative cutoffs along that list, each pinned
to a price target.

### Constants

```
MIN                 = BUSINESS_RULES.minimumQuoteAmount   // $1,000 (pre-tax)
TIER1_OVERSHOOT_PCT = 0.15                                // Tier 1 may reach 1.15·MIN
```

### The three cutoffs

- **Tier 1 — Classic Glow** = **Santa's roofline + cheapest extras toward ~$1,000.**
  Walk the cheapest-first extras, adding while the running subtotal is below MIN. For
  the item that would cross MIN, include it **only if** the result stays ≤ `MIN ×
  (1 + TIER1_OVERSHOOT_PCT)`; otherwise stop. Big items are held back; Tier 1 lands at
  or just over $1,000 (occasionally just under, when every remaining item is big).
- **Tier 3 — The Full Yule** = **Gingerbread roofline + every extra** (the whole design).
- **Tier 2 — Full Festive** = **Gingerbread roofline + cheapest extras up to the
  midpoint** between Tier 1's extras-value and the full extras-value (same overshoot
  grace). This guarantees a genuine middle: on a small quote it's Tier 1's items on the
  upgraded roofline; on a big quote it adds a real middle chunk of extras.

Then each tier is priced with `priceSelection` + the staff-default rush/takedown state
(unchanged helpers), and **Custom (D)** is appended via `applyOurRecommendation`
(unchanged).

### Spacing guarantee (no duplicate cards)

After building, **de-dupe by item set**: if two tiers resolve to the same set of
line-item ids, keep the lower-priced one and drop the other. So a quote with too little
to differentiate three levels shows 2 distinct cards + Custom instead of a duplicate.
The portal already numbers visible tiers by **position**, so dropping a card renumbers
the rest automatically.

### What does NOT change

- How selecting a package works downstream (`SelectionContext.selectPackage` replaces
  the selection with the card's `includedItemIds`; pricing derives from the selected
  items via `priceSelection`; the live design hides deselected scene items). Only **which
  items each card contains** changes.
- The **Custom / "Our Recommendation"** card and `applyOurRecommendation` (#12).
- Tier **names**/taglines (renamable labels).
- The mutually-exclusive roofline group + the $1,000 approval gate.

## Worked example (the real quote above, after the change)

Extras cheapest-first: $70, $70, $70, $95, $95, $95, $105, **$285 (wreath)**.

- **Tier 1:** Santa's $320 + (70+70+70+95+95+95+105 = $600) = **$920**. Next is the
  $285 wreath → $1,205, which exceeds $1,150 (1.15·$1k) → **held back**. Tier 1 = Santa's
  + bushes + spritzers, **no wreath**.
- **Tier 3:** Gingerbread $840 + all extras $885 = **$1,725**.
- **Tier 2:** midpoint of Tier 1 extras ($600) and full extras ($885) = $742.5 →
  Gingerbread $840 + cheapest extras to ~$742.5 = the same $600 (wreath excluded) =
  **$1,440**.

| Card | Pre-tax | With tax | Contents |
|---|---|---|---|
| **Tier 1 — Classic Glow** | $920 | ~$1,000.50 | Santa's + bushes + spritzers (no wreath) |
| **Tier 2 — Full Festive** | $1,440 | ~$1,566.00 | Gingerbread + bushes + spritzers |
| **Tier 3 — The Full Yule** | $1,725 | $1,875.94 | Gingerbread + everything (+ wreath) |

Three genuinely different cards: **Tier 1 → Tier 2** = the roofline upgrade;
**Tier 2 → Tier 3** = the wreath. No duplicates.

## Edge cases

- **No distinct Gingerbread roofline** (legacy/single roofline): use the one roofline
  for every tier; the roofline-upgrade step disappears but the cheapest-first item
  steps remain. De-dupe handles any collapse.
- **Roofline only** (no extras): all tiers equal → one card + Custom.
- **Very small quote** (one cheap extra after the roofline): Tier 2/Tier 3 may equal
  → de-dupe to 2 cards + Custom.
- **Tier 1 lands under $1,000** (all remaining extras are big): allowed; the approval
  gate shows the customer "+$X to approve."
- **Sub-$1,000 whole quote:** the gate already waives; tiers build + de-dupe normally.

## Components / structure

Small pure functions in `derivePackages.ts`:

- `sortExtras(lineItems, rooflineIds)` → non-roofline items, cheapest-first.
- `fillToTarget(roofId, sortedExtras, target, overshootCap)` → the id set for a tier
  (roofline + cheapest extras up to `target`, with the single-item overshoot grace).
  Tier 1 uses `target = MIN, overshootCap = MIN × 1.15`; Tier 2 uses `target = midpoint`.
- `dedupeTiers(tiers)` → distinct tiers in order (drop equal item-sets).
- `derivePackages(...)` — unchanged signature; rewired to the above, then appends
  Custom (D) as today.

The old `buildEntryTier` (grab-cheapest-until-over-$1k, crossing item included) is
replaced by `fillToTarget` with the overshoot cap.

## Testing (TDD)

Pure functions → unit tests in `derivePackages.test.ts`:

- **The real-quote shape** (roofline pair + bushes/spritzers + one pricey wreath, no
  showpieces) → three distinct tiers $920 / $1,440 / $1,725; assert the wreath is held
  out of Tier 1 and Tier 2, present only in Tier 3.
- **Big quote** (many extras incl. expensive ones) → three distinct, ascending tiers;
  Tier 1 lands within [MIN, 1.15·MIN]; Tier 2 sits near the midpoint.
- **Overshoot rule:** a quote whose crossing item is *small* → Tier 1 includes it (lands
  just over MIN); a quote whose crossing item is *big* → Tier 1 stops under MIN.
- **De-dupe:** a quote with too little to differentiate → exactly 2 distinct cards +
  Custom; assert no duplicate.
- **No distinct Gingerbread** (single roofline) → tiers still build + de-dupe.
- **Totals parity:** each tier's total equals `priceSelection` over its item set (parity
  with the live `SelectionContext` total).

## Scope & ownership

- One file: `src/lib/portal/derivePackages.ts` (+ its test). **Jason's pricing/portal
  area** — his review before merge.
- Pure functions; **no DB change, no migration, no API change.** Downstream selection
  and pricing untouched.

## Validation plan (before merge)

Run the revised algorithm against a sample of **real quotes** (pulled from prod) and
confirm: 3 distinct, ascending tiers on richer quotes; clean 2-card collapse on small
ones; Tier 1 always lands in the intended ~$1,000 band; no duplicate cards anywhere.
Tune `TIER1_OVERSHOOT_PCT` / the midpoint if the real distribution shows weak spacing.

## Open / tunable

- `TIER1_OVERSHOOT_PCT` (default 15%).
- Tier 2 target (midpoint by default; could shift toward Tier 3 for a "fuller middle").
- Tier names / taglines (cosmetic).
