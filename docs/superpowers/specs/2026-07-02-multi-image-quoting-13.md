# Multi-image quoting (#13) — locked spec

> Scoped S19 (2026-07-02) via a 6-agent recon workflow + completeness critic + two
> Q&A rounds with Jason. All forks below are LOCKED — don't re-ask. Old task #22.

## What it is

A quote today is built from exactly ONE street photo. Houses have quotable items
that photo can't see (around-the-corner bushes, side runs, backyard trees, a
detached garage). #13 lets staff add **N street photos** to the same quote, draw
on all of them, and present the whole display to the customer.

## Locked decisions

- **Extras are manual-only.** NO AI analyze on photos 2+ (avoids AI double-count;
  no cross-image dedup exists, deliberately). Staff tell the tool what's new by
  which tool they use (draw vs stamp — see linked twins).
- **Image 1 owns the roof measurement.** Satellite + calibration + footage stay a
  photo-1 concern (#97 satellite-preservation semantics pinned to photo-1). The
  satellite already sees roof sections photo-1 can't, so pricing is already right.
- **Items drawn on extras PRICE** (they project to line items — the design stays
  the master item list, #27) — EXCEPT linked twins (below), which are render-only.
- **Strand redraws on extras are visual + tagged** (option b): staff may draw ANY
  strand type (santas/gingerbread/C9/stake/WW — backyard roofline included) on any
  photo. Footage math is untouched; the tag links the strands to the line item so
  portal select/unselect dims them on every photo (tag-based toggling already
  spans photos).
- **Architecture: ONE design + `extra_photos[]` + optional `photoId` on scene
  items.** Absent/null photoId = the base photo → every existing design is
  back-compat by default. Keeps the `designs_quote_id_uniq` 1:1 index and the
  portal-loader / inventory-jobs / PDF / sceneLinks shapes untouched. (The
  N-sibling-designs alternative was REJECTED: it breaks every `maybeSingle()`
  consumer — the materials list would come back silently EMPTY.)
- **No cap** on extra photos. **Optional titles**, editable at the upload slot AND
  the editor switcher; untitled → "Photo N" on the portal.
- **Add-photo sources:** manual file upload + grab-another-Street-View-vantage
  (reuse #15's move-along-street UI); the grabbed pano lands as an extra, no
  analyze.

## Linked twins (the headline feature)

Traditional YLL designs redraw the WHOLE display on every photo (the same tree
decorated in photo 1 AND photo 2), because customers buy the display, not two
bushes. The tool supports this without double-billing:

- **Draw fresh** on any photo → a NEW billable item.
- **"Place on this photo" (stamp)** → pick an existing item → click its position
  on the active photo → a **linked twin**: copies the original's decoration
  (colors/size/wrap), carries `photoId` + a link to the canonical item,
  **render-only** — excluded from pricing projection, materials/inventory, and
  fulfillability.
- **Portal sync:** the line item links to the canonical item AND its twins —
  customer toggles an item off → it vanishes from every photo's render; color
  swatch changes recolor all representations.
- **Delete semantics:** deleting the canonical item removes its twins everywhere;
  deleting a twin removes just that photo's depiction, never the billable item.
- Fallback: an item-panel "same as: [existing item]" selector for draw-first,
  link-later. Both write the same link.
- Roofline/gingerbread/C9/stake/WW strands need NO twin mechanism — they toggle
  by TAG, per-unit items (bush/tree/wreath/spritzer/garland/mini) are the ones
  that twin.

## Portal presentation

- **Hero:** photo-1 live render + a **thumbnail strip** below it (titles as
  labels); tap/click flips the hero to that photo's lit render. Zero extras → no
  strip, portal identical to today.
- **Reprise ("Your home, lit up"):** on-image left/right ARROWS + dots (no strip —
  too bulky there). Swipe on phone.
- **All-photos gallery (🧪 TRIAL — Jason reviews on device, may drop):** a section
  between the totals box and "Your Protection" showing every photo's lit render
  at once. Desktop: 2–3-across grid. Mobile: stacked full-width (~2 visible per
  screen — do NOT skip on phones; 80–85% of customers are on phones).
- Selection state is live in ALL of these (toggle an item off → every render
  updates).

## Operator surfaces

- Builder: extra-photo upload slots + SV-vantage grab + title fields.
- Editor: photo tab strip (ported UX from the standalone design tool's
  "add another design" tabs — `client/src/pages/project.ts:47-112`, never imported
  in #27; adapted: tabs = photos of ONE design, "+ Add photo"). Switch = remount
  the stage on that photo with items filtered by photoId (mirrors the design
  tool's own teardown/remount switch — lowest-risk).
- Quote reopen (`/quote/<id>`): loads extras (it's the builder).
- Admin detail (`/admin/quotes/<id>`): small thumbnails, read-only.

## Data model (PR1)

- `designs.extra_photos jsonb` — array of
  `{ id, path, w, h, title? }` (storage path under the design's own
  `{designId}/extra-<photoId>.<ext>` prefix, so `deleteDesign`'s prefix-removal +
  the #229 retention purge cover extras with ZERO changes).
- `ItemBase.photoId?: string | null` — additive+optional binding-style field
  (like `surface`/`included`). RELAY NOTE: reaches the design tool's `api.ts`
  with the PR2a editor-core relay, not before.
- PR2b adds the twin link field (`linkedToId`) — NOT in PR1.

## PR plan + checkpoints

| PR | Slice | Checkpoint |
|---|---|---|
| 1 | Data: migration + extra-photo CRUD API + `photoId` type (⚠️ SHARED `sceneTypes.ts` — Naldo heads-up) + this spec | **CP1** |
| 2a | Editor-core: photo tab strip, add/switch/delete/title (**relay**) | **CP1** |
| 2b | Editor-core: stamp tool + linked twins + "same as" fallback (**relay, hardest**) | CP2 |
| 3 | Builder: upload slots + SV vantage + titles | CP2 |
| 4 | Portal: hero strip · reprise arrows · gallery (🧪 trial) | CP3 |
| 5 | Guards: twin-exclusion (projection/materials/fulfillability) + reopen + admin thumbs + retention/tests | CP3 |

Checkpoints = Jason verifies + merges bottom-up before the next slice starts.
Relays land only on approved editor-core PRs.

## Deferred / adjacent

- Training capture stays photo-1-only (extras interplay → #109 / #8).
- Migration ordering: column-add = **migration-first** (apply `extra_photos` to
  prod before the CP1 merge).
