# Spike: can a vision model scale a street photo off a front door?

Throwaway experiment (no production code touched, no DB writes). Script:
`scripts/spikes/door-anchor-experiment.ts`. Raw output: `door-anchor-results.json`
(every run, both reference calcs, and every aggregate below is derived straight
from that file — nothing here is hand-typed).

## Question

Can a vision model reliably establish pixels-per-foot from a known-size object
in a house photo, accurately enough to size bushes for pricing? Candidate
anchor: the front door (80in standard height).

## Subset and run count

26 rows in `training_examples` are exactly 640x400 (Google Street View
default) — chosen over the full 44 per the brief, to run more repeats per
photo instead of more photos, since the run-to-run question needed the
repeats more than the coverage did. Confirmed by direct query before running
(44 total, 26 at 640x400, 44/44 have a photo).

**78 live vision calls** (`claude-sonnet-4-6`, 26 photos x 3 runs, concurrency
4). 0 call failures, 0 JSON-parse failures.

**Caveat on the 26: only 16 are distinct addresses.** 6 Birch Road accounts
for 9 of the 26 rows (35%), 65 Forest Road and 741 Naple Ave two each — almost
certainly the same underlying photo re-captured into multiple training
examples across separate quotes for the same house. Every stat below is
reported both at the row level (26) and, where it changes the picture,
deduplicated to one row per address (16) — the ratio numbers move noticeably
between the two, run-to-run variance does not.

## 1. Anchor-found rate, by object type

| Object | Calls | Photos (all 3 runs agreed) |
|---|---|---|
| front_door | 51 / 78 (65%) | 17 / 26 |
| garage_door | 27 / 78 (35%) | 9 / 26 |
| window / step_riser / brick_course / none | 0 | 0 |

The model never reported "none" or fell back to a window, riser, or brick
course anywhere in this corpus — every photo had a usable door-family anchor.
That's a ceiling-case dataset (Google Street View front elevations, door
usually centered and unobstructed); a wider photo population would need this
re-run.

## 2. Run-to-run variance for the same photo (lead number)

This is the test the yardstick failed — one address yardsticked twice
disagreed by 72%. Here, all 26 photos got usable door-derived ppf on all 3
runs (78/78).

- **Row-level: mean CV (stdev/mean) = 4.0%, max CV = 11.3%** (later corrected
  to look at bbox-level detail below — 12.7% on the worst row once matched to
  its exact run trace).
- **Deduplicated to 16 distinct addresses: mean CV = 5.5%, max CV = 12.7%.**
- **Object-type agreement: 26/26 photos** — every repeated call on the same
  photo picked the same object (front_door vs garage_door never flipped
  within a photo), and the (x,y) location of the bbox moved by single-digit
  pixels run to run in every case. bbox aspect ratio (width/height) stayed in
  a physically plausible 0.39-0.61 band for every single front_door call — no
  run mistook a window or a garage door for a front door.
- **Worst case: `dc8fbe62` (12 Jamar Ln, Ronkonkoma), bbox height 98px / 82px
  / 72px across the 3 runs (CV 12.7%)** — location was stable (x=334, y=142-148
  every run) but the reported bottom edge of the door moved, most likely an
  obstructed threshold (steps/planters at the base making the sill ambiguous
  run to run). This is the one photo worth hand-checking before trusting the
  method on a similar porch.

**This is a large, real improvement over the yardstick's demonstrated 72%
disagreement on a re-measurement of the same address.** But see the "how good
does this need to be" section below — 4-12% ppf noise does not mean 4-12%
price noise.

## 3. Door-derived vs roofline-derived ppf

Per the brief's own caveat, these measure different depth planes (door: near,
low; roofline: far, high) and are **not expected to match** — this section
reports the ratio's distribution and, specifically, whether it's a *stable*
offset (correctable) or *scattered* (not).

- Roofline reference was usable on 20/26 rows (16/26 distinct addresses) —
  6 rows had either `santasFootage=0` (2 rows, footage never confirmed) or a
  scene with no traced `santas-roofline` polylines on the base photo despite
  nonzero footage (4 rows, footage most likely traced on an extra photo of a
  multi-photo house, not the base street photo this script scored).
- **Row-level ratio (door_ppf / roofline_ppf): mean 1.742, stdev 0.476 (CV
  27%), range 1.309-3.055 (2.3x spread).**
- **Deduplicated to distinct addresses (n=10): mean 2.016, stdev 0.498 (CV
  25%), range 1.395-3.055.**

**The offset is not a stable, correctable factor.** It's consistently >1 (the
near door reads more px/ft than the distant roofline, which is physically the
right direction — foreground objects subtend more pixels per real foot than
elevated/receding ones on the same camera), but the *size* of that gap swings
by more than 2x across houses, almost certainly driven by per-address
differences in camera distance/angle in the Street View capture. You cannot
apply one global multiplier to reconcile door-scale against roofline-scale.

Door vs yardstick (the WEAK reference) is similarly scattered — ratio range
0.744-2.52 — and is itself suspect, since the yardstick corpus is the thing
already measured as carrying mostly-untouched `realFeet=5` defaults.

## 4. Absurd-answer cases, and a correction to how I checked for them

The brief asked to flag any front-door reading whose implied real height
(cross-checked against an independent reference) fell outside 5-9ft. I
computed this using the roofline as the independent reference — **and it
fires on 26 of 45 eligible front_door runs (58%)**, which sounds damning but
is mostly an artifact of section 3's finding, not a detection-quality signal:
since the door/roofline ratio *averages* 1.74x with a floor around 1.3x, the
average "implied height via roofline" is already ~11-12ft before any
per-photo noise is added — a [5,9]ft window built on top of a reference that
runs 30-200% high by design will trip on most rows regardless of whether the
door was found correctly.

That's a real tension in the brief worth naming directly (see item 8): item 5
says the roofline and door aren't expected to match because they're different
depth planes, and item 6 asks to use that same mismatched reference as an
absolute-height sanity check — those two instructions pull against each
other. I did not have a second anchor at the *door's own* depth plane (a step
riser or brick course cross-check, both of which the model never picked in
this corpus) to validate against independently, so I could not build a
non-circular absurdity guard from this corpus alone.

What I *can* report cleanly, because it doesn't depend on an external
reference: **every one of the 51 front_door bboxes had a physically plausible
aspect ratio (0.39-0.61 width/height — a real door is roughly 0.45)**, and no
run ever relabeled a window or garage door as a front door. If I were
designing the guard a production system needs, I'd build it from those two
signals instead — reject a bbox whose aspect ratio falls outside a plausible
band for the claimed object, and require object-type + bbox agreement across
at least 2 of 3 repeated calls — rather than a feet-based check against a
reference at a different depth. The closest thing to a genuine "watch this
one" case in the data is `dc8fbe62`'s 12.7% run-to-run bbox-height CV (section
2) and `f76fda42` / `cbb7fa95`'s outlier ratios (3.06x and 1.83x against
roofline, the two widest gaps in the set) — worth a human glance, not proof of
a wrong detection.

## 5. Verdict — is this good enough to price from?

**Not ready, but a real step up from the yardstick specifically on
repeatability — and repeatability is necessary, not sufficient.**

Two things this experiment can and cannot say:

- **Can say: the door anchor is far more self-consistent than the yardstick.**
  4-5.5% mean run-to-run ppf noise (worst case 12.7%) vs. the yardstick's
  documented 72% swing on a re-measurement of the same address. Object
  identity and bbox shape were stable across repeats in every single case in
  this corpus.
- **Cannot say: the door anchor is accurate.** This corpus has no
  independently-measured ground truth for bush dimensions (or door dimensions)
  to check against — only two *other* photo-derived scale estimates
  (roofline, yardstick) that measure a different depth plane or are
  themselves known-unreliable. A method can be perfectly repeatable and still
  be wrong by a constant bias (e.g., if the model's door bbox systematically
  runs 10% short because it's excluding the threshold, ppf would be
  consistently and invisibly ~10% high, every run, on every photo).

That gap matters more than it looks because **the error does not pass
through to the billed number, it compounds.** Per the real strand-count
rules: `wraps = height / spacing`, `footage = (wraps x circumference) / 12`,
`strands = footage / 25` (6in spacing) `or / 17` (4in spacing). Both height
and circumference are pixel measurements divided by the SAME ppf, so
footage is proportional to ppf^-2 — a 20% scale error becomes roughly a 44%
footage error, and by extension a comparably distorted strand count and
price. Applying that squaring to what was actually measured here:

- The **4-5.5% mean run-to-run ppf noise** alone (before any accuracy
  question) becomes roughly an **8-11% footage swing** between two runs of
  the identical photo, on an otherwise-identical bush.
- The **worst-case 12.7% ppf noise** (the obstructed-threshold photo) becomes
  roughly a **27% footage swing**.
- Since accuracy (not just repeatability) is unmeasured here, any systematic
  bias in the 80in door-height assumption, or in where the model draws the
  sill, rides on top of that noise and could be considerably larger — this
  spike cannot bound it.

**Recommendation before this touches pricing:** validate against real
measurements (pick a handful of already-serviced addresses, measure actual
bush height/circumference on site or from a scaled reference photo, compare
to door-derived ppf) — repeatability alone is not evidence of correctness.
If it validates, run 2-3 calls per photo and take the median/majority (single
calls at ~5-13% noise are not safe on their own, given the squaring above),
and reject on bbox aspect-ratio implausibility rather than a
different-depth-plane feet check. It is a substantially more promising
candidate than the yardstick, but "more promising than a method already
proven broken" is not the same bar as "safe to price from."

## 6. What was wrong in the brief

- **The absurd-case check (item 6) and the roofline caveat (item 5)
  contradict each other**, as explained in section 4: you're told the
  roofline and door aren't expected to agree because of depth, then asked to
  use the roofline to catch an absurd door reading via a fixed feet window.
  Doing so literally produces a 58% "absurd" rate that is actually mostly the
  expected depth-plane gap from item 5, not a defect rate. I've reported the
  literal number plus the (much more informative) aspect-ratio and
  run-to-run signals instead of treating 58% as "58% of detections are
  wrong."
- **The "26/44 is the cleanest subset because resolution isn't a confound"
  framing undersold a real confound: address duplication.** 9 of the 26 rows
  are the same house (6 Birch Road), captured across separate training
  examples. It doesn't invalidate the run-to-run result (that's testing model
  repeatability on one image, duplicates or not) but it does skew the
  door/roofline ratio distribution toward that one house's numbers unless
  deduplicated — done above, and it changes the mean ratio from 1.74 to 2.02.
- Everything else in the brief (the strand-math squaring correction relayed
  mid-task, the standard sizes, the "use height not width for a door" call,
  the reference-A/reference-B split) held up and is reflected as given.
