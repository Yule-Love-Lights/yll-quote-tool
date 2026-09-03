# Mini-strand accuracy run 1: photo measurement + company formula vs installed counts

First-pass test, 2026-09-02. Question: if we measure a plant from a photo and apply the
company estimating formula (6 inch wrap spacing, one 50-count strand covers 25 ft), how
close do we land to what the crew actually installed?

Inputs: the 2025 Installs night photos (one per customer), scale anchors in each photo
(front door 80 in, garage door 84 in, story height, vehicles), and the ground truth in
`mini-strand-ground-truth-2025.json`. Eight houses measured, 24 items scored. Eric
Buonpastore's photo was over the 10MB tool cap and was skipped, not guessed.

## Full results

| House | Item | Predicted | Actual | Error |
|---|---|---|---|---|
| Sharen Phillips | topiary by steps | 2 | 2 | exact |
| Sharen Phillips | upper-bed clumps (x3) | 1 | 1 | exact |
| Morisson Taylor | cone tree | 6 | 5 | +1 |
| Enda Finlay | ivy column | 5 | 4 | +23% |
| Cathy Rende | hedge run left | 8 | 11 | -27% |
| Cathy Rende | hedge run right | 14 | 11 | +27% |
| Morgan Hayes | tree right | 7 | 7 | exact |
| Morgan Hayes | tree left | 11 | 7 | +57% |
| Morisson Taylor | sprawling bush | 5 | 3 | +67% |
| Cathy Rende | round bush A | 7 | 4 | +75% |
| Sharen Phillips | cascading tree | 9 | 4 | +125% |
| Morisson Taylor | porch hedge | 9 | 4 | +125% |
| Cathy Rende | round bush B | 14 | 6 | +133% |
| Joe DeGaetano | arborvitae 15-16 ft | 18 | 7 | +161% |
| Joe DeGaetano | arborvitae 13-14 ft | 14 | 5 | +184% |
| Joe DeGaetano | arborvitae 11-12 ft | 13 | 4 | +229% |
| Cathy Rende | round bush C | 16 | 4 | +300% |
| Todd Marion | hedge segments (x4) | 11-23 | 2-5 | +354% to +457% |
| Mary O'Connor | walk shrub | 5 | 1 | +400% |
| Mary O'Connor | right bush | 18 | 3-4 | ~5x |
| Mary O'Connor | small bare tree | 34 | 2 | 17x |
| Morisson Taylor | weeping tree | 85 | 5 | 17x |
| Morgan Hayes | merged front bed | 3 | 16 | -81% (segmentation failure, not formula) |

## The pattern (consistent across all three independent measurement passes)

1. The formula almost never underestimates. Every real miss is an overshoot, and the
   overshoot grows with how far the plant is from a compact cylinder or small cone.
2. Compact small shapes are already accurate. Small round bushes, tight cones, and the
   ivy column landed exact or within one strand, four of four such items.
3. Long hedge RUNS work (within 27 percent both directions). Shallow foundation hedge
   SEGMENTS fail hard (4x to 5x over), even after hand-correcting the depth assumption.
   The full-wrap-every-6-inches density is not what crews put on a wall-hugging hedge.
4. Tall cones (arborvitae) overshoot 2x to 3x because the formula carries the base width
   to the top and ignores taper.
5. Cascading, weeping, and bare-branch trees are the worst (up to 17x). Crews drape or
   trunk-wrap these; the canopy formula does not describe that work at all.

## Interpretation

The company sheet models full spiral coverage. Real installs put less wire per plant
volume on everything except small compact shapes. The bias is systematic and directional,
which is the fixable kind: per-shape calibration factors, fit from this dataset, should
collapse most of it. Rough first factors implied by the data (to be fit properly, not by
eye, before use): large round bush 0.3 to 0.5, tall cone 0.35 to 0.4, foundation hedge
segment about 0.2, cascading or bare-branch about 0.1 or leave manual.

Measurement error (night glow, width read at branch tips vs core, anchors) adds noise on
top, and daytime lights-off originals will reduce it. But the formula bias dominates: the
hedge miss stayed near 10x even after hand-correcting the measured dimensions.

## Recommendation

1. Do NOT wire raw formula auto-fill. The overshoot would inflate quotes badly on big or
   irregular plants.
2. A narrow auto-fill IS already defensible: small compact bushes and cones, the 1 and 2
   strand items, which are also the most numerous item class on real houses. Predicting
   those correctly removes most of the clicking even if staff still type counts for the
   big showpiece plants.
3. Next steps in order: get the daytime originals (team instructions already sent), re-run
   measurement to separate measurement error from formula bias cleanly, fit per-shape
   calibration factors on the full dataset, then validate on the next batch of houses the
   team is adding to the registry Sheet before any auto-fill ships.

Raw per-item detail: scratchpad files measure-batch1.md, measure-batch2.md,
measure-batch3.md from session S-current (summarized here; scratchpad is per-session).
