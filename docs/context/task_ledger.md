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
| 27 | **Design-tool integration (Path B)** — absorb the Konva design editor into this app; Supabase-stored editable `scene`; **line-items ⇄ scene-items linked both ways**; live design **replaces the static portal render**; phased (manual embedded editor → portal live-design + toggle→scene filter → AI auto-design). Full plan: [[project_integration]]; design-tool internals: `docs/design-tool-context/`. ⮕ don't keep investing in the Gemini portal-hero render (slated for replacement). | L (epic) | **BUILDING (S4)** — Phase 1 BACKEND done (`designs` table+bucket, `src/lib/designs.ts`, API routes; smoke-tested) + editor-port FOUNDATION done (scene types `src/lib/design/sceneTypes.ts`, commit `e79cd34`); branch `jason/integration-phase1`. **Approach = Option B** (#29 = later cohesion restyle). Next = the visible editor-port half (~3–5 hrs). | — |

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
