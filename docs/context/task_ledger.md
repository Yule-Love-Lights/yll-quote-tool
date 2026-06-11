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
| 28 | Standalone-`bow` line-item category — drawn bows project per-instance ("Bow" line item + portal toggle w/ Ribbon icon); manual "Bows" builder section; **price = $0 placeholder, TODO Naldo** (see ⏸️ #17) | S | S7 | — |
| 33 | Roofline portal PICTURE-toggle — the S5 link/hide mechanism was already complete; shipped the missing tagging via **auto-seeded tagged C9 strands from the builder's measurement lines** (create-time seed + "Sync roofline from measurement" button; replacement keys on the surface tag; contract v0.5). Legacy designs: hand-drawn UNTAGGED rooflines aren't auto-replaced — delete them once in the editor after the first sync | M | S7 | — |

## 🟡 In planning — NOT building yet (current)
| # | Task | Size | Status | Old # |
|---|------|------|--------|-------|
| 8 | AI training/correction system refinement → detail in [[task_ai_training_refinement]] | L | **planning DONE (S3)** — issues + direction captured; build deferred (feeds #27 Phase 3) | #28 |
| 9 | Manual satellite upload on `/quote/new` (front + satellite split) — companion to #8 | M | planning | #28a |
| 35 | **Design-first `/quote/new` restructure** (raised S7, Jason) — the Street View measurement box becomes the embedded DESIGN TOOL (street photo = design base photo); the AI-detection overlay + ALL manual per-unit form sections REMOVED (design = master list; custom items stay — the escape hatch); **satellite or manual typing = the ONLY measurement sources** (kills the "Pricing uses" radio; mostly solves #25); roofline add-line buttons satellite-tab-only; **Phase 2 = bridge auto-design** (today's AI detections → scene items; the plumbing #8 inherits); builder render preview died here (full teardown = #36). No legacy fallback (test quotes get wiped before launch). DO BEFORE #8. | L | **✅ COMPLETE (S7, both phases).** Phase 1 (PR #25): tabs/eager-design/removals/C3b. Phase 2 (`2ca774b`+`777a7d4`): `seedFromAnalysis` — designs open ALREADY DESIGNED from the analysis (items + a derived **5ft scale yardstick**; staff calibration always wins; `seed-` replacement rules; seeded garland sections default 1). | — |
| 36 | **Gemini/AI render pipeline TEARDOWN** (raised S7, Jason) — the live design replaced the static renders; remove the whole stack: `/api/renders`, `src/lib/rendering/*`, admin render pages, portal variant photos/galleries + render fallbacks, video-page dependency check, `renders` table/storage, Gemini/Replicate deps + env vars (⚠️ keep the Google keys used for Street View/geocoding). The builder-side preview already died in #35 Phase 1. Scope recon needed at pickup (the S7 recon agent for this died). | M–L | backlog — after #35 | — |
| 27 | **Design-tool integration (Path B)** — absorb the Konva design editor into this app; Supabase-stored editable `scene`; **line-items ⇄ scene-items linked both ways**; live design **replaces the static portal render**; phased (manual embedded editor → portal live-design + toggle→scene filter → AI auto-design). Full plan: [[project_integration]]; design-tool internals: `docs/design-tool-context/`. ⮕ don't keep investing in the Gemini portal-hero render (slated for replacement). | L (epic) | **✅ CORE DONE & MERGED (S5).** Phase 1 (#18) + Phase 2 (#19) + the FULL PROJECTION A1→D + **A2** — all merged via PR `jason/integration-projection`. Design = master item list; per-unit pricing from the scene; A1 gated Quote-binding editor; D portal toggle-filter (verified); Scattershot mini-areas + colors; railing/column bill at $35/string (no wrap; only trees vary); railing grouping; cores byte-identical (zero `[yll]`), 99 tests. **NEXT (Jason's sequence):** #31 edit-existing-quote → #33 roofline picture-toggle + #28 bow item → #8/Phase 3 AI auto-design. Later: #29 cohesion restyle, #10 portal color picker, editor Settings/palette, headless renderer. Plan: [[project_integration]]. | — |

## 🔜 Backlog — active dev (priority order)
| # | Task | Size | Notes | Old # |
|---|------|------|-------|-------|
| 10 | Portal color/pattern picker (operator default → customer-changeable) | M | | #26 |
| 11 | Re-analyze button for uploaded images | S–M | | #23 |
| 12 | Operator "recommend items" checkboxes in the builder | S | low priority | #19 |
| 13 | Multi-image quoting (manual-only, no AI auto-quote) | L | big | #22 |
| 14 | Corner-house default → front-door view | M | feasibility TBD | #20 |
| 15 | Move Street View camera along the road | M | feasibility TBD | #21 |
| 25 | **Satellite-default pricing + decouple "Pricing uses" from the view toggle** (fix the sticky reset bug). Satellite is more accurate (top-down, exact zoom-derived scale, no perspective), so default pricing to satellite when available, sticking until staff picks street or enters manual. Today a `useEffect` forces `measurementSource = viewMode` on every view switch (quote/new ~L191-193), clobbering the explicit pick; default is 'street'. Relates to #9. | S–M | quote/new (new, raised S3) | — |
| 26 | **Scroll-wheel zoom + pan inside the measurement image box** (the street/satellite editing area). Today you can only ctrl-zoom the whole browser; staff want to scroll-zoom + pan just the image for precise line/decoration placement. NOTE: that box is an `<img>` + **SVG overlay** + draggable point-handles (NOT an HTML `<canvas>`), so zoom must transform image+overlay together and coexist with point-dragging (wheel=zoom, drag handle=edit point, drag empty=pan). Applies to quote/new + training/new. | M | quote/new + training/new (new, raised S3) | — |
| 29 | **Restyle the embedded design editor to match the quote tool (the "Option A" cohesion pass)** — Jason's explicit want (S4). Phase 1 drops the design tool's editor in AS-IS via **Option B** (its own vanilla side panels, wrapped in a React shell — fast, low-risk). This task is the follow-on cleanup: rebuild those side panels/buttons in the quote tool's React+Tailwind style so the editor looks/feels native, wired to the shared engine (the headless-engine + native-panels "Option A" shape). Same functionality to the user — it's a rebuild of the controls, not a reskin; needs testing. Ties into the shared `editor-core`/`EditorStorage` work (see [[project_integration]]). Do AFTER #27 Phase 1 ships. | M–L | design editor (new, raised S4) — future cohesion pass | — |
| 30 | **`/admin/quotes` table overflows — the row Delete button is cut off / unreachable.** Each row has Portal↗ / Video / Send / **Delete**, but the table is wider than the viewport with no horizontal scroll, so Delete is off-screen (can't shift-scroll or zoom to reach it). Make the table fit (responsive/condensed columns) or horizontally scrollable, or move Delete. `src/app/admin/quotes/page.tsx`. | S | admin (new, raised S4) | — |
| 32 | **Make the spritzer ray-density factor editable in Settings** — the `0.45` rays-per-pixel constant in `editor-core/spritzer.ts` (`numRays = radiusPx * 0.45`) is hard-coded. Jason wants it tunable from the editor Settings page when that's built, so we can dial ray density without a code change. Small; folds into the deferred Settings work (palette/per-type defaults). Shared editor → coordinate w/ design-tool AI. | S | design editor (new, raised S4) | — |
| 34 | **Railing polish** — railing PRICING ✅ **DONE (S5)** at the standard $35/string; the editor wrap-style dropdown hide also ✅ DONE (S5, upstreamed `32aa324`). **Remaining (cosmetic only):** a dedicated portal `railing` icon/kind (today it rides `bush` — `lineItemKind.ts`). | S | portal (cosmetic) | — |

## ⏸️ Pending / needs Naldo (blocked — not active dev)
| # | Task | Size | Notes | Old # |
|---|------|------|-------|-------|
| 16 | Wire prod CRM + home.works | M | on hold — likely intentional during testing | #5 |
| 17 | Bow prices ($0 placeholders) — the 4.5ft-garland `bow` tier AND the standalone bow (`standaloneBowPrice`, #28/S7) | S | needs Naldo's numbers | #8 |
| 18 | Verify renders RLS | S | | ~#4 (old Naldo list) |
| 19 | Dormant portals decision (keep dark/concierge components?) | S | | #6 |
| 20 | Dev Supabase environment | S | | #7 |
| 21 | HighLevel stage mapping | S | | #9 |
| 22 | Real Google reviews + rating/count on portal | S | | #10 |
| 23 | Phone/video assets | S | | #11 |
| 24 | Apply migration + image cleanup | S | | #14 |

> Note: tasks #8/#9 are the active focus (planning only — Jason hasn't said build yet). Backlog order (10→15) reflects current priority; sizes are Jason-confirmed (don't silently adjust).
