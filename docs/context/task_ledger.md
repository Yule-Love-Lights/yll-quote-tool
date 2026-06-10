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

## 🟡 In planning — NOT building yet (current)
| # | Task | Size | Status | Old # |
|---|------|------|--------|-------|
| 8 | AI training/correction system refinement → detail in [[task_ai_training_refinement]] | L | **planning DONE (S3)** — issues + direction captured; build deferred (feeds #27 Phase 3) | #28 |
| 9 | Manual satellite upload on `/quote/new` (front + satellite split) — companion to #8 | M | planning | #28a |
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
| 28 | **Add a standalone-`bow` line-item category to the pricing engine** — a bow sold on its own (rare; or on garland) is a real Christmas product the quote can't price today. Surfaced by the design-tool integration data contract (#27). Bows inside wreaths / on garland are already priced via tier; only a standalone bow needs this. | S | pricing engine (new, raised S3) | — |
| 26 | **Scroll-wheel zoom + pan inside the measurement image box** (the street/satellite editing area). Today you can only ctrl-zoom the whole browser; staff want to scroll-zoom + pan just the image for precise line/decoration placement. NOTE: that box is an `<img>` + **SVG overlay** + draggable point-handles (NOT an HTML `<canvas>`), so zoom must transform image+overlay together and coexist with point-dragging (wheel=zoom, drag handle=edit point, drag empty=pan). Applies to quote/new + training/new. | M | quote/new + training/new (new, raised S3) | — |
| 29 | **Restyle the embedded design editor to match the quote tool (the "Option A" cohesion pass)** — Jason's explicit want (S4). Phase 1 drops the design tool's editor in AS-IS via **Option B** (its own vanilla side panels, wrapped in a React shell — fast, low-risk). This task is the follow-on cleanup: rebuild those side panels/buttons in the quote tool's React+Tailwind style so the editor looks/feels native, wired to the shared engine (the headless-engine + native-panels "Option A" shape). Same functionality to the user — it's a rebuild of the controls, not a reskin; needs testing. Ties into the shared `editor-core`/`EditorStorage` work (see [[project_integration]]). Do AFTER #27 Phase 1 ships. | M–L | design editor (new, raised S4) — future cohesion pass | — |
| 30 | **`/admin/quotes` table overflows — the row Delete button is cut off / unreachable.** Each row has Portal↗ / Video / Send / **Delete**, but the table is wider than the viewport with no horizontal scroll, so Delete is off-screen (can't shift-scroll or zoom to reach it). Make the table fit (responsive/condensed columns) or horizontally scrollable, or move Delete. `src/app/admin/quotes/page.tsx`. | S | admin (new, raised S4) | — |
| 31 | **Edit an existing quote (load it back into the builder).** Today `/quote/new` only CREATES quotes — there's no way to reopen a saved quote to tweak its inputs OR its attached design. Needed for real use + for re-testing #27 designs (the design links to a quote on Calculate, but you can't reopen it). Add an edit route (e.g. `/quote/[id]` or `?id=`) that hydrates the builder form + the linked design. Relates to #27 (reopening the design editor on an existing quote). | M | quote/new (new, raised S4) | — |
| 32 | **Make the spritzer ray-density factor editable in Settings** — the `0.45` rays-per-pixel constant in `editor-core/spritzer.ts` (`numRays = radiusPx * 0.45`) is hard-coded. Jason wants it tunable from the editor Settings page when that's built, so we can dial ray density without a code change. Small; folds into the deferred Settings work (palette/per-type defaults). Shared editor → coordinate w/ design-tool AI. | S | design editor (new, raised S4) | — |
| 33 | **Roofline portal PICTURE-toggle** — on the portal, Santa's↔Gingerbread changes the PRICE but not the live PICTURE, because the design's c9 roofline strands aren't tagged `santas-roofline` vs `gingerbread` (the surface picker exists in the editor as of A1, but tagging is manual + tedious, and one continuous roofline strand can't be split front-vs-sides). Fix: better roofline tagging UX and/or auto-tag from the AI front/sides classification (#7/#17). Per-unit toggles + the price toggle already work. | M | portal/editor (new, raised S5) — Jason: after A2 | — |
| 34 | **Railing polish** — railing PRICING ✅ **DONE (S5)**: prices at the canopy/standard **$35/string** (same per-string cost as a bush — Jason confirmed, NO Naldo $ needed), no wrap style; bills via `projectScene` (`surface:"railing"` → mini) + `calculateMiniLights` (railing special-case) + `lineItemKind` (rides `bush` kind on the portal). **Remaining:** (a) design-tool editor — hide the Wrap-style dropdown when `surface:"railing"` (relayed); (b) optional — a dedicated portal `railing` icon/kind (today it rides `bush`). | S | pricing engine (done S5) + design editor | — |

## ⏸️ Pending / needs Naldo (blocked — not active dev)
| # | Task | Size | Notes | Old # |
|---|------|------|-------|-------|
| 16 | Wire prod CRM + home.works | M | on hold — likely intentional during testing | #5 |
| 17 | Bow-tier price ($0 placeholder) | S | needs Naldo's number | #8 |
| 18 | Verify renders RLS | S | | ~#4 (old Naldo list) |
| 19 | Dormant portals decision (keep dark/concierge components?) | S | | #6 |
| 20 | Dev Supabase environment | S | | #7 |
| 21 | HighLevel stage mapping | S | | #9 |
| 22 | Real Google reviews + rating/count on portal | S | | #10 |
| 23 | Phone/video assets | S | | #11 |
| 24 | Apply migration + image cleanup | S | | #14 |

> Note: tasks #8/#9 are the active focus (planning only — Jason hasn't said build yet). Backlog order (10→15) reflects current priority; sizes are Jason-confirmed (don't silently adjust).
