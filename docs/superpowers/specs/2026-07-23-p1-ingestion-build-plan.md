# #167 P1 — Archive ingestion: concrete build plan

**Date:** 2026-07-23 · **Owner:** Naldo (build touches training = Jason's area → Jason heads-up before any merge) · **Status:** PLAN for approval. No code, no DB writes yet.

Companion to the epic spec `2026-07-20-training-data-flywheel.md`. This is the buildable P1 slice list, sized against the **210 resolved photos / 80 properties** already committed in `data/2026-07-23-resolved-photos-cumulative.csv`.

## The key realization: most of this already exists

P1 is much smaller than the epic spec implied, because two hard parts are already built in the app:

1. **Address → satellite-with-scale is done.** `/api/estimate` and `/api/analyze-address` already geocode an address, fetch the Google satellite image, and compute feet-per-pixel. We **reuse** that — we do not build a new imagery pipeline.
2. **The geometry-tracing UI is done.** `/training/new` already lets staff enter an address, tag photos, trace roofline/lights, run the mini-light geometry calculator (`calcStringsFromBox`), and save a full `training_houses` row that few-shot retrieval already consumes.

So P1 is mostly: a **staging table** + a **loader** for the resolved CSV + a **queue index** that pre-fills the existing `/training/new` — not a from-scratch editor or imagery service.

## Data model

**New table `archive_photos`** (the review queue / staging; migration-first):

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| created_at / updated_at | timestamptz | |
| drive_file_id | text | Google Drive file id (from the manifest) |
| source_folder | text | which archive folder |
| original_title | text | e.g. `img13.png` |
| content_hash | text unique | dedup across re-runs |
| classification | text | `install_night` \| `tree_bush_markup` \| `design_doc` \| `other` (P1 defaults `install_night`; vision-classify is P2 polish) |
| resolved_address | text | from the manifest (raw, as typed — displayed, never grouped on) |
| resolved_address_key | text generated | normalized twin (mirrors `properties.address_key`); the queue GROUPs by this |
| resolved_customer_id | uuid → customers | null when address-only / not-in-CRM |
| resolved_customer_ref | text | the 8-char prefix as recorded; makes a failed link detectable + re-linkable |
| resolved_name | text | the name the human typed — the cross-check that a link points at the right customer |
| resolved_ghl_id | text | null |
| not_in_crm | boolean | true for the `NOT-IN-CRM` rows (e.g. "tal") |
| satellite_ref | text | storage path once fetched (null until slice 2) |
| street_view_ref | text | storage path |
| satellite_feet_per_pixel | numeric | from the reused estimate fetch |
| extracted_counts | jsonb | OCR'd tree markup counts — **P2**, null in P1 |
| status | text | `pending` → `imagery_fetched` → `ready_to_trace` → `approved` \| `excluded` |
| reviewer_notes | text | |
| promoted_training_house_id | uuid → training_houses | set on approve |

RLS: operator-only (staff), matching the other training tables. **Do not** reuse `training_houses` as the staging table — keep the corpus clean; promote into it on approve.

**New storage bucket `training-archive`** (private): holds downscaled Drive originals + fetched Google satellite/Street View, path-referenced (not base64), per the epic spec's storage decision. HEIC originals get converted to JPG on ingest for display.

## Build slices (small, reviewable, in order)

**Slice 1 — schema + loader (migration-first).**
- Migration: create `archive_photos` + the `training-archive` bucket + RLS policies + indexes (`content_hash` unique, `status`, `resolved_address`).
- Loader: a one-shot script/route that reads `data/2026-07-23-resolved-photos-cumulative.csv`, dedups by `drive_file_id`, and inserts `archive_photos` rows (address + contact + drive ref, `status='pending'`, `excluded` for the `skip` rows). Idempotent (re-runnable via the unique hash).
- **Outcome:** the 210 resolved photos / 80 properties are live in the DB. This is the "we've started" milestone.

**Slice 2 — imagery fetch (reuse estimate pipeline).**
- Per distinct `resolved_address` (80 of them): call the existing satellite/Street-View fetch, store both images in `training-archive`, set `satellite_ref` / `street_view_ref` / `satellite_feet_per_pixel`, move `status` → `ready_to_trace`.
- Batched + resumable; skips addresses already fetched.
- **Needs:** confirmation the estimate flow's Google key/quota can take ~80 lookups (one-time). No new key if we reuse it.

**Slice 3 — review queue UI (pre-fill the existing tracer).**
- New index page `/training/archive`: lists `ready_to_trace` rows **grouped by property** (so a house's multiple angles show as one item), with the archive night photo(s) + the fetched satellite/Street-View thumbnails, and per-property counts (e.g. "9 photos · 1991 Broadhollow Rd").
- "Trace this house" opens `/training/new` **pre-filled** from the `archive_photos` row: address in, satellite (with feet-per-pixel) loaded, archive night photos attached as reference. Staff trace the roofline/lights on the daytime satellite (the night photo is the "what was actually installed" reference, not an analyzer input).
- Save promotes to `training_houses` (source `archive`), sets `promoted_training_house_id`, `status='approved'`. The existing few-shot retrieval picks it up automatically — no change to inference code.
- Skip/exclude for non-installs.
- **Reuse `/training/new` wholesale**; the only new UI is the queue index + the pre-fill wiring.

**Slice 4 — trees/bushes (this is P2, listed for completeness).** OCR the marked-up tree photos → `extracted_counts` → `plant_examples`. Not part of P1.

## Who works the queue

80 properties to trace. On a familiar satellite a roofline trace is ~2 min → **~3 hours total**, splittable between Naldo and Jason across sittings. This human step is what turns an address into a real training example — it's the point of the loop, not overhead. The queue index shows remaining count so it's grind-down visible, same as the naming artifact.

## Order of operations / dependencies

1. Slice 1 migration lands (table + bucket exist) **before** the loader runs (migration-first pitfall).
2. Loader (Slice 1) before imagery (Slice 2) before tracing (Slice 3).
3. Every slice: branch → gates (tsc·lint·vitest) → four-lens pre-merge review → Naldo go + Jason heads-up (training area) → merge → verify.
4. The 22 unresolved photos are ignored by the loader (not in the manifest); they fold in with a later manifest drop — zero rework.

## Open decisions before Slice 1

1. **App ↔ Drive access.** The loader references Drive file ids, but the imagery/display path needs the app to read those Drive files (a Drive API service-account credential), **or** we point ingestion at the named copies. Which — grant the app Drive read, or export the named photos to a bucket/folder the app already reads?
2. **Google imagery quota.** Confirm the estimate flow's key can absorb ~80 one-time satellite+Street-View lookups (almost certainly yes).
3. **Storage of the night photos.** Copy the Drive originals into `training-archive` (self-contained, survives Drive changes) vs. reference Drive by id (lighter, but breaks if a file moves). Recommend: copy downscaled JPGs into the bucket.
4. **`training_houses` shape fit.** Confirm the archive rows map cleanly onto the existing columns, or whether a light `source`/`is_archive` marker is worth adding so archive-sourced examples are filterable in `/training`.

## Audit follow-ups (from the slice-1 pre-merge review — carry into slices 2/3)

Slice 1 shipped with these knowingly deferred. They are NOT bugs in slice 1; they are the next
slices' work, written down so they don't get rediscovered late.

1. **`training-archive` storage bucket — deferred to slice 2.** The plan listed bucket creation in
   slice 1, but nothing writes to it until slice 2 fetches imagery. Slice 2's first migration
   creates it: `insert into storage.buckets (id, name, public) values ('training-archive',
   'training-archive', false) on conflict (id) do nothing;` (the designs/custom-uploads precedent).
2. **`satellite_feet_per_pixel` is not a pass-through to the tracer.** The estimate pipeline's
   feet-per-pixel and what `/training/new` consumes are not the same unit today, and the satellite
   image's pixel width has to be recorded alongside it. Slice 3's "pre-fill" needs an explicit
   conversion step plus new state-seeding code in the tracer — budget for it rather than assuming
   the value drops straight in.
3. **The `not_in_crm` rows need their own queue lane.** Two rows (`IMG_0901` "tal", `img203`
   69 31st street wyandanch) are flagged `not_in_crm`. The slice-3 index must show a "needs
   identification" section (`resolved_address is null or not_in_crm`), or they sit in `pending`
   forever, never reaching `ready_to_trace` and never surfacing to a human.
4. **Three address variants still split into separate queue cards.** `resolved_address_key`
   normalizes case/punctuation (it correctly merges the 4-photo `6 Birch Road` house), but three
   pairs are genuinely different strings and need a human call before or during slice 3 — they are
   probably the same property each:
   - `230 W 24th StDeer Park, NY 11729.` (missing space) vs `230 W 24th St Deer Park, NY 11729`
   - `18 Daisy Court Farmingdale` vs `18 Daisy Court, Farmingdale, New York 11735`
   - `9 high ridge lane` vs `9 high ridge lane oyster bay`
   Left as typed rather than silently merged: collapsing them is a judgment call about which
   houses are the same, not a mechanical normalization. Distinct properties after normalization:
   **80** (77 if all three pairs merge).
5. **`hl:` / `ghl:` contact refs have no resolver.** All 49 links in this batch are `cid:`. The
   generator now hard-fails on an unknown ref type instead of silently dropping the link, so a
   future batch that uses a GHL-only contact stops loudly; wire `resolved_ghl_id` when that lands.
6. **Cross-check `resolved_address` against `properties.address_key`.** For the 49 customer-linked
   rows the address was typed independently and never reconciled against that customer's own
   canonical property record. A slice-3 sanity pass could flag disagreements.

## What this does NOT change

Inference is untouched — promoted rows flow through the existing few-shot retrieval. No prompt changes, no pricing changes. Pure data-in + a review surface. The self-improving measurement (P4 scorecard) and the tree/bush estimator (P2) are separate, later.
