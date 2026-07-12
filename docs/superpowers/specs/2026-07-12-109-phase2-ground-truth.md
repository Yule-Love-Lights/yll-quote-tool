# #109 Phase 2 — Completed-install GROUND TRUTH (design doc, for review)

> Status: HELD (Naldo, S32 2026-07-12) — built + adversarially reviewed; the
> analyzer bias fold-in was found mathematically broken (money path), so the whole
> phase is parked. See "Build + review outcome (S32)" at the bottom for the 5
> confirmed defects + the correct-fix direction. Built code lives on branch
> `naldo/109-phase2-ground-truth` (no PR). The design below is the ORIGINAL plan.
> Author: assistant (S32, 2026-07-12). Relates to #8 / #54 / #27 / #104 / #13.
> Phase 1 (pre-fill from the approved design) shipped in PR #508.

## The one-sentence goal

Let the operator record the numbers they *actually installed* on a completed
job, store those as the trusted label, and use them to score the AI's guesses
over time — so we learn where to trust the vision model and where to correct it.

## Why (the principle behind it)

Today the training system learns from two things: the AI's raw guess (the
"seed") and the staff's hand-corrected markup (the "final"). Both are still
*estimates from a photo*. The one number nobody has captured is the **operator's
known truth** — "I put up 142 feet of C9 and 3 wreaths on this house." That is
better ground truth than any photo re-derivation, and it's the missing signal.

Phase 2 captures it and turns it into a measurable "how close was the AI?" score.
This is the LLM-council rule made real: **the AI is a draft generator; the
human-confirmed number is the saved label** — never let an unconfirmed detection
become ground truth.

## Where it plugs in (verified against current code)

- Save path today: `/training/new` → `POST /api/training` → `saveTrainingHouse()`
  (`src/lib/training.ts`) → INSERT into the `training_houses` table.
- Scoring infra to reuse (already exists, built for AI-seed-vs-staff-final):
  - `computeBiasSummary()` + `formatBiasNote()` — `src/lib/seedFinalStats.ts`
  - `summarizeSeedFinalDiff()` — `src/lib/seedFinalDiff.ts`
  - `getCorpusBiasNote()` (5-min cached, invalidated on write) — `src/lib/trainingExamples.ts`
  - Comparison thresholds already tuned: **3 ft** footage, **0.5** count, **1** string.

## Data model

Add ONE nullable column to `training_houses`:

```
operator_known_numbers  jsonb   -- nullable; null = operator didn't record truth
```

Shape (every field optional — the operator fills only what they actually know):

```json
{
  "miniLights":       12,      // count of mini-light wraps (bush/tree/column/railing)
  "wreaths":          3,
  "spritzers":        2,
  "garland":          4,       // garland runs / sections
  "santasFootage":    142,     // front-roofline C9 feet, if known
  "gingerbreadFootage": 88,    // ridge/side C9 feet, if known
  "wwFootage":        0,       // winter-wonderland C9 feet
  "stakeFootage":     0        // stake-lighting feet
}
```

**AI-vs-truth needs the AI's ORIGINAL guess.** To honestly score "how close was
the AI" (decision #4, flag big misses), we compare operator truth against the
AI's detection at Auto-Analyze time — NOT the saved markup (which may be
hand-corrected). So the same column also stores an AI snapshot, captured when the
operator runs Auto-Analyze on `/training/new`, plus the computed miss flags:

```json
{
  "known":     { "miniLights": 3, "wreaths": 3, ... },        // operator truth (new UI)
  "aiSnapshot":{ "miniLights": 3, "wreaths": 1, ... },        // AI's counts at last Auto-Analyze (auto-captured; absent if operator never ran it)
  "misses":    [ { "type": "wreaths", "ai": 1, "known": 3, "big": true } ]  // computed at save
}
```

When the operator never ran Auto-Analyze (hand-drew everything) there's no
`aiSnapshot`, so no AI score — that's fine, `known` is still saved as truth.

**Why one JSONB blob, not separate numeric columns:** the detection taxonomy
keeps growing (minis → spritzers → garland → stake → …). A blob adds new truth
fields with zero migrations; individual columns would need a migration each time.
It's operator-entered display/analysis data, never a money field, so we don't
need per-column typing/constraints.

**Migration order:** additive + nullable, so it ships **migration-first** (column
must exist before the code writes it); all reads treat `null` as "no truth
recorded" and behave exactly like today. Fail-open on every path.

## Capture UI

A new collapsed section on `/training/new`, titled **"What you actually installed
(ground truth)"**, with a one-line helper: *"The real counts from this job —
used to score the AI's guesses over time. Fill in only what you know."* Number
inputs for each field above, saved into `operator_known_numbers`. Collapsed by
default so it never gets in the way of the existing markup flow.

## Scoring (two outputs, both cheap)

1. **Save-time readout** — when the operator saves with truth entered, show a
   small "AI guessed X · you installed Y · off by Z" line per detection type
   (reusing `summarizeSeedFinalDiff` shaped for known-vs-AI). Immediate feedback,
   no new infra.
2. **Corpus bias correction** — extend `getCorpusBiasNote()` so that, where an
   operator-known number exists, the bias pair is **operator-truth vs AI-seed**
   (the strongest signal) instead of only staff-final vs AI-seed. Same thresholds,
   same 5-min cache, same prompt-injection point. Over time the analyzer's
   correction note ("you tend to under-count wreaths by ~1") is grounded in real
   install counts, not photo re-reads.

## Test plan (test-first)

- Delta math: known-vs-AI diff respects the 3ft / 0.5 / 1 thresholds; sub-threshold
  gaps report "match."
- Fail-open: `operator_known_numbers = null` → save + scoring behave byte-identical
  to today (no readout, bias note unchanged).
- Partial truth: operator fills only wreaths → only wreaths is scored; other types
  untouched.
- Bias fold-in: a house with operator truth contributes the known-vs-AI pair; a
  house without contributes the old staff-final pair (no double-count, no
  regression on the existing corpus math).
- Cache invalidation still fires on a training write.

## Decisions (Naldo, approved S32)

1. **Full build now** — migration + capture UI + scoring (readout + bias fold-in)
   + miss flag, one PR, test-first.
2. **Nudge the big four** — minis / wreaths / spritzers / garland get a visible
   "recommended" prompt; footage stays clearly optional. Soft nudge only: a
   dismissable "Save without recording install counts?" confirm if the big four
   are blank — NEVER a hard block (a block makes operators skip the section).
3. **New-saves-only** — capture on the new-save flow; no edit path for past
   `training_houses` rows in v1.
4. **Flag big misses** — when operator truth + an AI snapshot both exist, mark a
   line as a "big miss" when the gap clears a larger bar than the base
   match-thresholds: **count off by ≥ 2** (base 0.5), **footage off by ≥ 10 ft**
   (base 3 ft). Show the flag in the save-time readout AND persist it in `misses`
   so a future review view can list "houses where the AI was way off."

## Rollout / risk

Low risk: one additive nullable column, one new UI section, and an extension of an
existing scoring function that already ships. No money math, no customer-facing
surface, no change to the analyzer prompt itself (only the data feeding its bias
note). Everything degrades to today's behavior when truth is absent.

---

## Build + review outcome (S32) — HELD by Naldo

The full phase 2 was BUILT on branch `naldo/109-phase2-ground-truth` (pushed, no
PR) and passed gates (tsc 0, eslint 0, vitest 3201). A 5-lens adversarial review
(each finding independently verified) then found **5 confirmed defects, 1
refuted** — and 4 of the 5 live in the analyzer bias fold-in. Because the bias
note feeds the analyzer system prompt (a MONEY path), Naldo chose to **HOLD all of
phase 2** rather than ship the broken fold-in or drop approved scope. Nothing was
merged.

### The confirmed defects
1. **Partial-record dilution (MED).** `knownAiPairToSeedFinal` fills every
   unrecorded metric with `known.X ?? aiSnapshot.X` → a fabricated 0 delta ("AI
   was exactly right"). Those zeros share the SINGLE denominator `n =
   seeded.length` in `computeBiasSummary`, so partial ground-truth records (the
   common case — the nudge only fires when ALL four counts are blank) dilute the
   real bias measured from `training_examples`. Enough partials push a genuine
   bias below `COUNT_THRESHOLD` and the calibration line vanishes. **More data =
   worse calibration.**
2. **Strand metric poisoned (MED).** `fakeMini` hardcodes `stringCount: 0` and
   there is NO operator field for strand counts, so every ground-truth pair
   injects a structural 0 into the `miniStrings` metric, padding its denominator
   and suppressing a real strand-undercount line as the corpus grows.
3. **Outlier injection (MED).** The route sanitizer only range-checks; one
   in-bounds-but-absurd value (e.g. wreaths=9999) dominates a mean over as few as
   `MIN_STATS_PAIRS=5` pairs and lands in the live analyzer prompt on the next
   save (cache is busted immediately). No winsorizing/outlier rejection.
4. **Multi-photo aiSnapshot mismatch (MED).** `known` is summed whole-house
   across all photos (`combined*Detections`), but `aiSnapshot` is captured
   per-Auto-Analyze on the active photo and overwritten each run — so on a
   multi-photo house it reflects only the LAST analyzed photo. The AI-vs-truth
   comparison (and the readout) then uses the wrong AI baseline.
5. **Fractional counts (LOW).** `asNonNegNumber` stores a fractional count (2.7)
   verbatim; physical install counts can't be fractional (should round like the
   existing `clampStringCount`).

### The correct-fix direction (for the redo)
The root cause of 1+2 is forcing ground-truth pairs through the `seed/final` shape,
which has no "not observed" representation, so the code fabricates the value that
reads as zero bias. Fix by **per-metric observation**, not fabrication:
- Count each metric only where it was actually OBSERVED — for a ground-truth pair
  that means only the fields the operator recorded AND the AI returns. A metric
  the operator left blank contributes nothing (not a zero). `miniStrings` is NEVER
  observed by ground truth (no strand input) → ground truth never touches it.
- This needs `computeBiasSummary` to track a per-metric denominator, OR the
  ground-truth contribution to be accumulated separately and merged per-metric.
  Existing `training_examples` pairs observe every metric, so per-metric counting
  leaves their behavior unchanged (safe blast radius).
- Fix #3 with outlier guarding (clamp/winsorize per-pair, or a robust statistic).
- Fix #4 by aggregating `aiSnapshot` across all photos at save (mirror how
  `known`/`combined*Detections` are whole-house).
- Fix #5 by rounding counts in the sanitizer.

The capture UI + save-time readout + miss flag are otherwise sound (readout needs
the #4 multi-photo aggregation fix too). If phase 2 is revived, the capture half
is salvageable from the branch; the fold-in should be rebuilt to the above.
