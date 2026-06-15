---
name: task-ledger
description: Master task ledger — the single clean renumbered list of all tasks (done / planning / backlog / Naldo-pending) with size + status. LIVING DOC — keep current as work lands.
metadata: 
  node_type: memory
  type: project
  originSessionId: e4aa4be2-5f3b-45ef-ba10-c5884f1b5b20
---

# Task ledger (master list)

> **Single source of truth for tasks.** LIVING DOC — update statuses as work lands; this supersedes the old scattered QA punch-list. Renumbered into ONE clean sequence on 2026-06-03; the **Old #** column maps to the messy historical numbers still referenced in `session_log.md` + PR titles. **Size:** S (hours) · M (~a session) · L (multi-session / epic).
>
> **CONVENTION (Jason likes this):** when a task completes, move it to ✅ Completed and ALWAYS record the **session it shipped in** in the `Shipped` column (matching `session_log.md` numbering — S1, S2, S3, …; use a range like S2–S3 if it spanned sessions). Keep this for every task going forward.

## ✅ Completed
| # | Task | Size | Shipped | Old # |
|---|------|------|---------|-------|
| 1 | Foundation — onboarding, lint→error refactor, Next 16.2.6 security bump, WebP, Vitest, docs | M | S1 | — |
| 2 | Portal consolidation — one Snowglobe portal at `/portal`; retired old skins/routes | L | S2 | #27 |
| 3 | C9 line-delete resets derived footage (bug) | S | S2 | #24 |
| 4 | Discount input accepts `20` (not `0.20`) | S | S2 | #25 |
| 5 | $1,000 minimum → customer-portal approval gate (not an engine floor) | M | S2 | #18 |
| 6 | Customer rush-install + premium-takedown portal toggles | M | S2 | #4 |
| 7 | Roofline redesign (Santa's/Gingerbread) — Phases 1/1b/2/4 (PRs #12/#13/#14) | L (epic) | S2–S3 | #17 |
| 31 | Edit an existing quote — `/quote/[id]` hydrates the builder + linked design; Calculate updates the row in place (and `/quote/new` stops duplicating rows after the first save); Sent/Approved warning badge; admin Edit links | M | S6 | — |
| 28 | Standalone-`bow` line-item category — drawn bows project per-instance ("Bow" line item + portal toggle w/ Ribbon icon); manual "Bows" builder section; **price = $0 placeholder, TODO Naldo** (see ⏸️ #17) | S | S6 | — |
| 33 | Roofline portal PICTURE-toggle — the S5 link/hide mechanism was already complete; shipped the missing tagging via **auto-seeded tagged C9 strands from the builder's measurement lines** (create-time seed + "Sync roofline from measurement" button; replacement keys on the surface tag; contract v0.5). Legacy designs: hand-drawn UNTAGGED rooflines aren't auto-replaced — delete them once in the editor after the first sync | M | S6 | — |
| 30 | Admin quotes table overflow — the container was `overflow-hidden`, CLIPPING the Delete button; now `overflow-x-auto` (scrolls) | S | S6 | — |
| 34 | Dedicated portal `railing` kind + Fence icon (was riding `bush`); Tier B; pricing unchanged ($35/string since S5) | S | S6 | — |
| 11 | Re-analyze for uploaded photos — CLOSED BY #35: the Analyze button persists after analysis and re-clicking re-analyzes + re-seeds the design | S | S6 (via #35) | #23 |
| 25 | Satellite-default pricing + sticky-source bug — CLOSED BY #35: street is no longer a measurement source, the "Pricing uses" radio is gone, satellite-or-manual is the rule | S–M | S6 (via #35) | — |
| 36 | **Gemini/AI render pipeline TEARDOWN** — executed from the S6-locked plan: DELETED `src/lib/rendering/*` (8 files), the 4 render API routes, the 3 admin render pages, `PackageVariantGallery` + `variantPhoto.ts` + all `variantPhotos` plumbing (both already orphaned); `portal/photos.ts` → pure null-URL fallback; admin "Renders" link removed; `migrations/2026-06-12-drop-renders.sql` (Jason applies + deletes the `renders` bucket in the UI); FULL-SCHEMA purged; example-env + docs scrubbed. 7 env vars removed; KEPT `GOOGLE_MAPS_API_KEY`/`ANTHROPIC_API_KEY`/sharp/`@anthropic-ai/sdk`. Video untouched (grep-verified). Closed #18 as moot. | M–L | S7 | — |
| 18 | Verify renders RLS — **CLOSED AS MOOT by #36 (S7):** the `renders` table + bucket no longer exist | S | S7 (moot via #36) | ~#4 (old Naldo list) |

## 🟡 In planning — NOT building yet (current)
| # | Task | Size | Status | Old # |
|---|------|------|--------|-------|
| 8 | AI training/correction system refinement → detail in [[task_ai_training_refinement]] | L | **Stage A MERGED (S7, PR #30)** — scene-based capture + few-shot. **Stage B SHIPPED (S8)** — Voyage+pgvector similarity retrieval, unified pipeline; re-verified live + committed on `jason/few-shot-retrieval` (`e9a09e7`/`cdfe543`/`2f2cd3e`+docs), **MERGED to master (S8)**. **Stage C round 1 (C1 per-example seed→final diff · C2 corpus bias block · C3 satellite orientation self-check) MERGED (S8, PR #33); C4 (garland sections — compute fix, NO schema) BUILT + committed (S8, PR off master)**; only C6 (per-detection confidence) deferred. | #28 |
| 9 | Manual satellite upload on `/quote/new` (front + satellite split) — **DONE (S7, via #8 Stage A):** manual satellite slot on /quote/new feeds the design + training capture | M | S7 | #28a |
| 35 | **Design-first `/quote/new` restructure** (raised S6, Jason) — the Street View measurement box becomes the embedded DESIGN TOOL (street photo = design base photo); the AI-detection overlay + ALL manual per-unit form sections REMOVED (design = master list; custom items stay — the escape hatch); **satellite or manual typing = the ONLY measurement sources** (kills the "Pricing uses" radio; mostly solves #25); roofline add-line buttons satellite-tab-only; **Phase 2 = bridge auto-design** (today's AI detections → scene items; the plumbing #8 inherits); builder render preview died here (full teardown = #36). No legacy fallback (test quotes get wiped before launch). DO BEFORE #8. | L | **✅ COMPLETE (S6, both phases).** Phase 1 (PR #25): tabs/eager-design/removals/C3b. Phase 2 (`2ca774b`+`777a7d4`): `seedFromAnalysis` — designs open ALREADY DESIGNED from the analysis (items + a derived **5ft scale yardstick**; staff calibration always wins; `seed-` replacement rules; seeded garland sections default 1). | — |
| 27 | **Design-tool integration (Path B)** — absorb the Konva design editor into this app; Supabase-stored editable `scene`; **line-items ⇄ scene-items linked both ways**; live design **replaces the static portal render**; phased (manual embedded editor → portal live-design + toggle→scene filter → AI auto-design). Full plan: [[project_integration]]; design-tool internals: `docs/design-tool-context/`. ⮕ don't keep investing in the Gemini portal-hero render (slated for replacement). | L (epic) | **✅ CORE DONE & MERGED (S5).** Phase 1 (#18) + Phase 2 (#19) + the FULL PROJECTION A1→D + **A2** — all merged via PR `jason/integration-projection`. Design = master item list; per-unit pricing from the scene; A1 gated Quote-binding editor; D portal toggle-filter (verified); Scattershot mini-areas + colors; railing/column bill at $35/string (no wrap; only trees vary); railing grouping; cores byte-identical (zero `[yll]`), 99 tests. **NEXT (Jason's sequence):** #31 edit-existing-quote → #33 roofline picture-toggle + #28 bow item → #8/Phase 3 AI auto-design. Later: #29 cohesion restyle, #10 portal color picker, editor Settings/palette, headless renderer. Plan: [[project_integration]]. | — |

## 🔜 Backlog — active dev (priority order)
| # | Task | Size | Notes | Old # |
|---|------|------|-------|-------|
| 10 | Portal color/pattern picker (operator default → customer-changeable) | M | | #26 |
| 12 | Operator "recommend items" checkboxes in the builder | S | low priority — ⚠️ REVIEW before building: raised pre-design-first (S1); with #35 the design + `included` flags may already cover or reshape this | #19 |
| 13 | Multi-image quoting (manual-only, no AI auto-quote) | L | big | #22 |
| 14 | Corner-house default → front-door view | M | feasibility TBD | #20 |
| 15 | Move Street View camera along the road | M | feasibility TBD | #21 |
| 26 | **Scroll-wheel zoom + pan inside the measurement image box** (the street/satellite editing area). Today you can only ctrl-zoom the whole browser; staff want to scroll-zoom + pan just the image for precise line/decoration placement. NOTE: that box is an `<img>` + **SVG overlay** + draggable point-handles (NOT an HTML `<canvas>`), so zoom must transform image+overlay together and coexist with point-dragging (wheel=zoom, drag handle=edit point, drag empty=pan). Applies to quote/new + training/new. | M | quote/new + training/new (new, raised S3) | — |
| 29 | **Restyle the embedded design editor to match the quote tool (the "Option A" cohesion pass)** — Jason's explicit want (S4). Phase 1 drops the design tool's editor in AS-IS via **Option B** (its own vanilla side panels, wrapped in a React shell — fast, low-risk). This task is the follow-on cleanup: rebuild those side panels/buttons in the quote tool's React+Tailwind style so the editor looks/feels native, wired to the shared engine (the headless-engine + native-panels "Option A" shape). Same functionality to the user — it's a rebuild of the controls, not a reskin; needs testing. Ties into the shared `editor-core`/`EditorStorage` work (see [[project_integration]]). Do AFTER #27 Phase 1 ships. | M–L | design editor (new, raised S4) — future cohesion pass | — |
| 32 | **Make the spritzer ray-density factor editable in Settings** — the `0.45` rays-per-pixel constant in `editor-core/spritzer.ts` (`numRays = radiusPx * 0.45`) is hard-coded. Jason wants it tunable from the editor Settings page when that's built, so we can dial ray density without a code change. Small; folds into the deferred Settings work (palette/per-type defaults). Shared editor → coordinate w/ design-tool AI. | S | design editor (new, raised S4) | — |

## ⏸️ Pending / needs Naldo (blocked — not active dev)
| # | Task | Size | Notes | Old # |
|---|------|------|-------|-------|
| 16 | Wire prod CRM + home.works | M | on hold — likely intentional during testing | #5 |
| 17 | Bow prices ($0 placeholders) — the 4.5ft-garland `bow` tier AND the standalone bow (`standaloneBowPrice`, #28/S6) | S | needs Naldo's numbers | #8 |
| 19 | Dormant portals decision (keep dark/concierge components?) | S | | #6 |
| 20 | Dev Supabase environment | S | | #7 |
| 21 | HighLevel stage mapping | S | | #9 |
| 22 | Real Google reviews + rating/count on portal | S | | #10 |
| 23 | Phone/video assets | S | | #11 |
| 24 | Apply migration + image cleanup | S | | #14 |

> Note: #8 Stage A+B + #9 are SHIPPED; **#8 Stage C (designer brain) is the active focus.** Backlog order (10→15) reflects current priority; sizes are Jason-confirmed (don't silently adjust).
