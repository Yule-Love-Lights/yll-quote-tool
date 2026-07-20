# #167 — Training-data flywheel: bulk archive ingestion + tree/bush ground truth

**Date:** 2026-07-20 · **Owner:** Naldo · **Status:** SPEC — direction approved via Q&A (decisions below); build NOT started. Phase 1 first.

## Problem

The AI designer/measurer is the backbone of the tool, but its training corpus only grows when
staff send quotes — and after a month of live capture it holds **16 holiday examples, 2 permanent
examples, and 1 completed-job record**. Meanwhile Naldo is sitting on 4–5 years of completed-install
photos, including tree/bush photos with the actual mini-light string count written on them in markup.
Trees/bushes are where the company has historically lost the most money: counts were eyeballed,
and the tool today automates the eyeball rather than replacing it.

Goal: a **self-improving loop** — get the historical archive into the training corpus, give
trees/bushes a real ground-truth library + estimator, make customer photos a perpetual data source,
and measure accuracy so "improving" is a number, not a feeling.

## Current state (verified against live DB + code, 2026-07-20)

**Storage (all centralized in the quote-tool Supabase project — no new "central DB" needed):**

| Table | Rows | What it holds |
|---|---|---|
| `training_examples` | 16 (11 embedded) | Holiday: sat/street photos, AI's original guess, staff-corrected final scene, embedding |
| `permanent_training_examples` | 2 | Same shape, permanent vertical |
| `training_houses` | 1 | Completed-job library: photos, per-package footage, detections, costs/labor/revenue |
| `reference_assets` | 0 | Product close-ups (wreath/spritzer/garland) for prompt injection |

**Inference mechanism (corrects the "trains on the last three" belief):** retrieval-augmented
few-shot. Each analysis embeds the incoming photo (Voyage multimodal), retrieves up to **8**
visually similar examples (`FEW_SHOT_LIMIT`, `src/lib/fewShot.ts`; permanent cap 6) via pgvector
cosine RPC, injects them as synthetic user/assistant message pairs, plus a corpus-wide bias note
("your mini-string counts run ~N low"). Recency is only the fallback. No fine-tuning anywhere —
the model is stateless per call; `docs/context/task_ai_training_refinement.md` keeps fine-tuning
as a future RESEARCH TODO gated on corpus size.

**Existing feedback loop:** every quote **Send** auto-captures the corrected design as a training
example (`captureExample('auto-send')` in `QuoteBuilder.tsx`; upsert per quote — latest send wins).
So capture works; the corpus is just starved.

**Trees/bushes today:** priced as `stringCount × $35 (canopy) / $45 (trunk)`
(`pricingEngine.ts` `calculateMiniLights`). The count is guesswork: staff type a number, or the
analyzer reads a hardcoded size-bucket table ("medium tree: 5–8 strings") off a single photo with
no scale reference. A **real geometry calculator already exists** — box size → feet (calibrated
scale) → circumference × wraps-per-6in → footage → strings (`calcStringsFromBox`,
`src/app/training/new/page.tsx`) — but it's only wired into the internal training-capture page,
never the live quote flow. The customer self-serve `/estimate` excludes trees/bushes entirely
(`analysisToHolidayInputs` hardcodes `miniLightItems: []`).

**Customer surfaces:** no photo upload exists anywhere (lead form, `/estimate`, portal are all
photo-free); `PortalLineItem` has no estimated/pending state.

**#109 Phase 2** (reconcile actual installed counts vs quoted, fold error into calibration) was
built but **HELD** — adversarial review found 5 defects (incl. "mini-strand metric structurally
zeroed", "partial-record dilution"); findings in
`docs/superpowers/specs/2026-07-12-109-phase2-ground-truth.md`. No reconciled actual-vs-quoted
dataset exists in prod today.

## Decisions locked (Naldo Q&A, 2026-07-20)

1. **Archive location:** Google Drive + phone camera roll (exported into Drive); pre-install
   design docs live in Jobber and would be downloaded/uploaded manually.
2. **Tree markup numbers = mini-light strings** (50ct strands) — maps 1:1 to how the tool prices.
3. **Photo gating: ballpark + finalize.** Quote/estimate shows tree/bush lines as a
   satellite/street-view ballpark marked "final price after we see a photo" — never a hard block.
4. **Build order: Phase 1 (bulk ingestion) first.** It's the fuel for everything else.

## The flywheel (target architecture)

```
Naldo's archive (Drive)          customers (photos w/ quote)      crews (actual installs)
        │                                  │                              │
        ▼                                  ▼                              ▼
  [P1 bulk-ingest pipeline] ──────► review queue (staff approve/correct/exclude)
                                           │
                                           ▼
              corpus: training_houses · training_examples · plant_examples (new)
                                           │
                     ┌─────────────────────┼──────────────────────┐
                     ▼                     ▼                      ▼
          few-shot retrieval      [P2 tree/bush estimator]   [P4 scorecard/eval]
          (existing, cap 8)       (geometry + similar-plant)  (accuracy over time,
                     │                     │                   #109-P2 reconcile)
                     └────────► better quotes ◄────────────────────┘
                                     │
                        [P3] customer photos + confirmed installs feed back in
```

## Phase 1 — Bulk archive ingestion (BUILD FIRST)

**Input:** a curated Drive folder Naldo owns (suggested: `YLL Training Archive/<year>/<address or customer>/…`),
camera-roll photos exported into it, Jobber design docs downloaded into it manually.

**Pipeline (batch job, staff-triggered, idempotent):**

1. **Enumerate + dedupe** — walk the Drive folder; content-hash every file; skip already-ingested
   hashes so re-runs are safe.
2. **Classify** (vision pass per photo): completed-install house shot (usually night) ·
   marked-up tree/bush photo · pre-install design doc · other/skip.
3. **Read the markup** — OCR/vision extracts the handwritten string count from tree/bush photos
   (= mini-light strings per decision #2). Low-confidence reads flagged for review.
4. **Resolve the address** — folder/filename hints → EXIF GPS (reverse-geocode) → fuzzy match
   against `properties`/`customers`. Unresolved → review queue asks Naldo.
5. **Cross with Google** (Naldo's key idea — this is the strongest training data): for each
   resolved address, fetch current **satellite + Street View** imagery so the example pairs
   *what the tool sees at quote time* with *what was actually installed*. Night install photos
   alone don't match the analyzer's input distribution; paired examples do.
6. **Stage** everything as draft rows in a **review queue** — nothing enters the live corpus
   unreviewed.
7. **Review UI** (under `/training`): approve / correct count / fix address / exclude, one
   keyboard-fast card per item. On approve → write `training_houses` (house-level) or
   `plant_examples` (per-tree/bush, new in P2 schema) + compute embeddings.

**Schema/storage decisions:**
- Archive images go to a **Storage bucket** (`training-archive`), path-referenced — NOT base64
  columns. (Existing training tables store base64 in Postgres; fine at 16 rows, wrong at 1000+.
  Corpus entries that few-shot injection needs can keep a downscaled base64 copy on approval, so
  the existing injector path keeps working unchanged.)
- New `ingest_queue` table: file hash, drive ref, classification, extracted count + confidence,
  resolved address/property_id, status (pending/approved/excluded), reviewer notes.
- Migration order: column/table adds ship migration-first (per AGENTS.md pitfall).

**Explicitly out of scope for P1:** auto-approve (never), permanent-vertical archive (holiday
first), fine-tuning.

## Phase 2 — Tree/bush ground-truth library + real estimator

- **New table `plant_examples`:** photo path (+ downscaled base64 for injection), plant type
  (tree/bush), wrap style, **actual_strings** (verified), approx height/width if known, address,
  year, notes, `excluded`, `embedding`. Seeded by P1 from the marked-up tree photos; grown
  forever by P3.
- **Estimator in the live quote flow:** for each detected/drawn tree or bush —
  (a) **similar-plant retrieval**: top-N visually similar `plant_examples` with their real counts
  shown to the AI (and to staff in the sidebar: "5 similar trees we've done took 6–9 strings");
  (b) **geometry**: promote `calcStringsFromBox` out of `/training/new` into a shared lib and wire
  it into the editor's mini-area tool with a scale reference (roofline feet-per-pixel where
  usable, or a calibration click).
- Pricing rates ($35/$45 per string) are **unchanged** — this improves the count, not the rate.
  Analyzer-prompt edits here are a MONEY change per standing policy (Fable-eligible review,
  ask first).
- Mini-light seam caution: widening detection/estimator types must grep every consumer first
  (S18 pitfall — stale narrow copies behind `as` casts).

## Phase 3 — Customer tree/bush photos + ballpark-pending lines

- **Upload capability** (new): customer photo upload on the `/estimate` flow and the portal
  ("snap a photo of each tree/bush you want lit") → new storage bucket, size/type validation,
  linked to lead/quote.
- **Ballpark-pending state:** `PortalLineItem` gains an `estimated` (pending-photo) flag; portal
  copy: "ballpark from aerial imagery — final price after we see a photo." Quote totals include
  the ballpark (decision #3: never hard-block). Enumerate all `PortalLineItem`
  consumers before widening the type (S19 pitfall), and any service-type seams stay
  positive-match.
- **The perpetual loop:** every customer photo, once its job completes with a confirmed count,
  becomes a `plant_examples` row via the P1 review queue. Customer photos look like Naldo's
  tree photos — same distribution the estimator retrieves against.

## Phase 4 — Accuracy scorecard (make "self-improving" measurable)

- **Fix + land #109 Phase 2** (the 5 held defects are enumerated in its spec) so actual installed
  counts reconcile against quoted counts per job.
- **Golden eval set:** ~10–20 houses + trees with verified counts, held OUT of the few-shot
  corpus. A `/training` scorecard page runs the analyzer against the set on demand (after prompt
  edits / corpus growth) and tracks error over time: roofline footage %, mini-string delta per
  plant, detection recall. Re-anchoring golden numbers = money-math verdict (standing policy).
- Existing `seedFinalStats` bias note stays; the scorecard shows whether it's actually shrinking.

## What "self-improving" honestly means here

Retrieval + calibration, not weight updates: more verified examples → better similar-house/
similar-plant retrieval → tighter bias calibration → measured on the golden set. The model never
permanently "learns"; the corpus is the memory. Once the corpus is in the hundreds (post-P1),
actual fine-tuning becomes worth researching — that stays a deliberate future decision, per the
existing training doc.

## Open questions (don't block P1 start, but answer during build)

1. Rough archive size — hundreds or thousands of photos? (Affects batch/cost planning for the
   vision classify pass.)
2. Is the Drive archive already organized by year/customer, or one big dump? (Affects address
   resolution strategy.)
3. Who works the review queue — Naldo only, or Jason too?
4. Do camera-roll exports preserve EXIF GPS? (Google Photos/iCloud exports usually do; WhatsApp
   re-shares don't. Determines how much address matching is automatic.)

## Appendix — P1 source folders (inventoried 2026-07-20, same day as this spec)

Naldo shared 5 Drive folders (owner info@yulelovelights.com); full listing in
`data/2026-07-20-training-archive-inventory.csv` (695 files):

| # | Folder | Files | Named by customer? |
|---|---|---|---|
| 1 | Homes without Logo v2 (`1UGNu5rXy1jTRNJtxJYaZoyovRDK3tOOS`) | 192 | mostly; ~71 camera-named strays |
| 2 | Homes with Logo (`1-1im8H-vzE5ZGZhLkGSrjHzcrAtzuC7E`) | 87 | yes (watermarked dupes) |
| 3 | Homes without Logo (`1-3h0eizZGGnLn5sT47ptHyq9aHjtiN1C`) | 72 | yes; 2 strays |
| 4 | Homes Without Logo — older (`1n3EdwfDENWKdvpQLqEJa5O2PRKGuVShi`) | 190 | **no — all numbered img##.png** |
| 5 | 2025 Installs (`1OVHgD5DBLBpZTH26--fYfqSQVJNtU4Ia`) | 154 | yes, some with addresses |

263 files lacked customer names; 31 were auto-resolved as exact byte-size twins of named
files (`data/2026-07-20-photo-automatch.csv`; size match = candidate, verify pixels at ingest);
232 need human naming (`data/2026-07-20-photo-naming-checklist.md`, sent to Naldo 2026-07-20).
Notes for the P1 build: folder-4 files are PNG screenshots (no EXIF GPS → name/address must come
from the human pass); folders 1/3/5 HEIC/JPG originals likely carry EXIF GPS; folder 2 is
watermarked duplicates (dedupe against folder 1/3 by size/pixel, don't double-ingest). This
sandbox's network policy blocks raw Drive downloads (gateway 403), and the Drive connector
returns empty content for images and has no rename/delete ops (copy/create only) — so the
pipeline must run server-side in the app with proper Drive API credentials, not in a CCR shell.

Two P1 requirements locked by Naldo's follow-ups (2026-07-20): (1) **same-house multi-angle
clustering is a pipeline step** — pixel-level near-dup + same-house grouping runs BEFORE the
review queue so a house is confirmed once, not once per angle (the interim human checklist only
collapses provable byte-size duplicates and supports `img13-16 = Name` range replies);
(2) **names flow back into Drive** — the connector can't rename in place, so confirmed names are
written as copies into a canonical "YLL Training Archive — Named" Drive folder (originals
untouched), which becomes the pipeline's preferred source.

## Risks

- **OCR misreads of handwritten counts** → review queue catches; low-confidence flagged.
- **Address resolution failures** → queue prompts a human; never guess-write a wrong address.
- **Postgres bloat** → bucket-first storage (above), base64 only for approved corpus entries.
- **Distribution mismatch** (night photos vs daytime analyzer input) → mitigated by pairing with
  fresh Google imagery per address (P1 step 5).
- **Stale satellite imagery** vs install year (house may have changed) → review queue shows both;
  reviewer excludes mismatches.
