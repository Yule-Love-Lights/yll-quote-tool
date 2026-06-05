---
name: task-ai-training-refinement
description: Scoping + plan for the AI training/correction system refinement (the photoAnalysis few-shot loop). LIVING DOC — still in the listing-issues/planning phase; no building started yet.
metadata: 
  node_type: memory
  type: task
  originSessionId: e4aa4be2-5f3b-45ef-ba10-c5884f1b5b20
---

# AI training/correction system — refinement task (SCOPING / PLANNING)

> **Task #8 in [[task_ledger.md]]** (companion: #9 = manual satellite upload on `/quote/new`).
> **Status: PLANNING ONLY.** Jason wants to stay in "list the issues + plan" mode and is still adding feedback; do NOT start building until he says go. This doc is a running list — keep appending as more comes up. Started Session 3 (2026-06-03), Jason driving (Naldo originally built this system; Jason is learning it).

## Why this task exists
Phase 4 (#17) fixed the roofline classification in the prompt, but validating it exposed how little the "training" system actually does. Jason wants to understand it fully, then refine it so the tool is solid for years. Core realization driving everything:

**This is few-shot PROMPTING, not learning/fine-tuning.** Every Analyze is a fresh, stateless Claude API call; saved corrections/training-houses are just a few worked examples pasted into that one prompt for it to imitate. The model never permanently learns. Only the **latest 2** corrections (+ up to 2 training houses + 2 reference assets) are injected per call — a context/cost cap, not a bug. So "more data → smarter over time" (a fine-tuning mental model) is NOT how it currently works.

## Strategic direction (CONFIRMED with Jason)
Build toward "accumulate + improve," staged:
1. **Fix data capture / hygiene first** — every saved example clean + complete (correct red/blue, captured satellite image, records the ACTUAL install). The clean dataset is the durable asset for any path.
2. **Near-term: retrieval-based few-shot** — keep the WHOLE library; at quote time retrieve the most relevant N examples instead of "latest 2." **Match signal = image-embedding similarity (DECIDED, Jason): match on the actual house image, NOT style words.** Gives "gets better as we add data" today, with Claude, no fine-tuning.
3. **Future option: fine-tuning** — a step-change once the dataset is large + clean. Likely needs a vision-tunable model (Claude vision fine-tuning may not be generally available — RESEARCH needed, see below). Keep as a later decision, not now.

## Issues found (current state)
1. Few-shot, not learning; only latest 2 corrections used (cost/context cap).
2. **Corrections don't save the satellite IMAGE** — only the street photo. Satellite line coords ARE saved but orphaned (replayed with no image for the model to see → teach nothing). Jason wants corrections to save satellite image + tracings too, like street view.
3. **Training-house satellite photos get dropped** — priority #6, and the analyzer only sends the first 4 photos (`slice(0,4)` in `api/analyze-photo`). No dedicated satellite upload button either.
4. **Corrections "View" page (`/training/corrections`) doesn't draw the saved lines** on the photo — shows them only as a text list. Visualization gap (data is there).
5. **`/training/new` Analyze uses the QUOTING AI** (`/api/analyze-photo`) — it SUGGESTS where lights could go (hallucinated bush boxes on a roofline-only install) instead of READING what was actually installed. Wrong tool for the job. Compounded by lit-install-photo vs daytime-bare-photo mismatch (the quote AI expects bare daytime houses).
6. **Training-house fields stored but NEVER sent to the AI** (decide keep-vs-remove later; some maybe kept as business records): address, year_completed, general notes, C9/Winter-Wonderland footage+difficulty+c9_lines, the spritzers/wreaths/garland PRICING arrays (separate from the detection boxes), scale_anchor, "didnt_install", cost_materials, cost_labor_hours, revenue.
7. **House-style ranking is dead in practice** — the quote builder never sends a `houseStyle` hint, so `getTrainingFewShot` always falls back to recency (latest 2). The style field is stored but unused at quote time; the AI does NOT auto-detect style.
8. **Stale labels** — `/training/new` footage inputs still say "Gutterline ft" / "Ridgeline ft" (a Phase-4 leftover; canvas labels were updated but not this section). Should be Santa's/Front + Gingerbread (Ridge + Sides).
9. **Photo-tag system over-built** — front_install / front_takedown / side / back / detail / satellite. `front_takedown` purpose unclear (confirm with Naldo — possibly the bare/no-lights front).

## Planned changes / direction (EVOLVING — not final)
- **Photo uploads (both /training/new and the correction flow): simplify** to → "Install photo" (completed install, usually 1, sometimes more) + **dedicated Satellite** (Google pull for convenience OR manual upload fallback; canvas comes up to trace red/blue ON the satellite = "this is what we actually did") + optional "extra photos" catch-all. Drop the other tags.
- **Corrections (`/quote/new` save-correction): capture + save the satellite IMAGE + tracings** too (mirror the street-view save). Add a manual **"upload satellite image"** option alongside the Google pull + the existing manual front-of-house upload (so we can upload both a front image AND a satellite image when needed).
- **Satellite, end-to-end:** make sure the satellite image + lines are actually captured AND reach the model as training (today they're dropped/orphaned).
- **Retrieval-based few-shot** (the core upgrade): use the full dataset, retrieve best matches. Decide the match signal here.
- **`/training/new` Analyze:** consider a separate "detect what's installed in this photo" mode instead of the quoting AI.
- **Corrections View:** overlay the saved red/blue lines on the photo.
- **Fix the stale "Gutterline/Ridgeline" training labels** (small; could even be a quick pre-task fix).
- **Decide keep-vs-remove** on the AI-unused fields (#6) — cost/revenue/labor maybe kept as business records.
- **Google satellite pull cost:** negligible (~fractions of a cent/image, monthly free credit; quote flow already pulls it). Use Google pull + manual fallback.

## Adjacent change — manual satellite upload on `/quote/new` (may be its own small task)
Jason (clarified): on the **quote builder** (`/quote/new`), today you can upload ONE manual photo (any photo). He wants to **split that into two manual uploads — a front-of-home photo AND a satellite photo** — with Analyze working the same for each as it does when pulling from Google Maps. **Why:** so a manually-uploaded house can also carry a satellite view → more/better training data. **Coupling:** this is interdependent with the training work — corrections can only "save the satellite image" if `/quote/new` actually captures one. So do it as part of (or immediately alongside) this task's satellite-capture workstream, even though it's technically a quote-builder UI change. Jason left the task-placement to us.
**⚠️ SCALE CAVEAT (Jason realized this):** the Google-pulled satellite's accuracy comes from a KNOWN feet-per-pixel scale computed from the Static Maps zoom-20 + latitude formula (`analyze-address` route ~L71-77). A **manually uploaded** satellite has **no known scale** — the AI could still trace the layout (normalized coords) but couldn't compute reliable FOOTAGE without a scale reference. So a manual satellite is good for capturing the **tracing/layout (training)** but is **not pricing-accurate** unless we add a scale step. **Jason's resolution (don't over-build):** when staff manually upload a satellite, they'll already have the footage on hand from their own Google Maps and will just **enter it manually** — so NO auto-scale/reference mechanism is needed; the existing manual footage fields cover it. Manual satellite uploads are expected to be **rare** anyway (Google pull is reliable and far better than street view). Google-pull stays the auto-measured source. (Also see task #25 — making satellite the default pricing source.)

## Open questions / decisions deferred
- ~~House-style matching~~ **DECIDED (Jason): use image-embedding similarity as the retrieval match signal, NOT style words / a style-guesser.** Keep `house_style` as captured metadata only (not the match key).
- **`front_takedown` photo purpose** — confirm with Naldo.
- **Fine-tuning** — keep as a future option, gated on dataset size/quality + availability.

## RESEARCH TODO (later — do NOT do yet, Jason will say when)
- Current state of **Claude / vision-model fine-tuning** availability + options (Anthropic API limits; vision fine-tuning at other providers e.g. OpenAI GPT-4o, Google Gemini), so the "do we fine-tune eventually" decision is grounded in what's actually offered today.
