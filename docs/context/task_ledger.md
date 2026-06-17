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
| 27 | **Design-tool integration (Path B)** — absorbed the Konva editor into the app (Supabase-stored editable `scene`); design = master item list; per-unit pricing from the scene; live design replaces the static portal render; line-items ⇄ scene-items linked; A1 gated Quote-binding editor; D portal toggle-filter; A2 Scattershot mini-areas + railing/column billing. Cores byte-identical with the design tool. Plan: [[project_integration]]. | L (epic) | S4–S5 | — |
| 35 | **Design-first `/quote/new`** — the measurement box IS the embedded design tool (street photo = design base); manual per-unit forms removed (design = master; custom items stay the escape hatch); satellite-or-manual = the only measurement sources. Phase 2 bridge auto-design: `seedFromAnalysis` opens designs ALREADY DESIGNED from the AI analysis (+ a derived 5 ft scale yardstick; staff calibration wins; `seed-` replacement rules). | L | S6 | — |
| 31 | Edit an existing quote — `/quote/[id]` hydrates the builder + linked design; Calculate updates the row in place (and `/quote/new` stops duplicating rows after the first save); Sent/Approved warning badge; admin Edit links | M | S6 | — |
| 28 | Standalone-`bow` line-item category — drawn bows project per-instance ("Bow" line item + portal toggle w/ Ribbon icon); manual "Bows" builder section; **price = $0 placeholder, TODO Naldo** (see ⏸️ #17) | S | S6 | — |
| 33 | Roofline portal PICTURE-toggle — the S5 link/hide mechanism was already complete; shipped the missing tagging via **auto-seeded tagged C9 strands from the builder's measurement lines** (create-time seed + "Sync roofline from measurement" button; replacement keys on the surface tag; contract v0.5). Legacy designs: hand-drawn UNTAGGED rooflines aren't auto-replaced — delete them once in the editor after the first sync | M | S6 | — |
| 30 | Admin quotes table overflow — the container was `overflow-hidden`, CLIPPING the Delete button; now `overflow-x-auto` (scrolls) | S | S6 | — |
| 34 | Dedicated portal `railing` kind + Fence icon (was riding `bush`); Tier B; pricing unchanged ($35/string since S5) | S | S6 | — |
| 11 | Re-analyze for uploaded photos — CLOSED BY #35: the Analyze button persists after analysis and re-clicking re-analyzes + re-seeds the design | S | S6 (via #35) | #23 |
| 25 | Satellite-default pricing + sticky-source bug — CLOSED BY #35: street is no longer a measurement source, the "Pricing uses" radio is gone, satellite-or-manual is the rule | S–M | S6 (via #35) | — |
| 36 | **Gemini/AI render pipeline TEARDOWN** — executed from the S6-locked plan: DELETED `src/lib/rendering/*` (8 files), the 4 render API routes, the 3 admin render pages, `PackageVariantGallery` + `variantPhoto.ts` + all `variantPhotos` plumbing (both already orphaned); `portal/photos.ts` → pure null-URL fallback; admin "Renders" link removed; `migrations/2026-06-12-drop-renders.sql`; FULL-SCHEMA purged; example-env + docs scrubbed. 7 env vars removed; KEPT `GOOGLE_MAPS_API_KEY`/`ANTHROPIC_API_KEY`/sharp/`@anthropic-ai/sdk`. Video untouched. Closed #18 as moot. | M–L | S7 | — |
| 18 | Verify renders RLS — **CLOSED AS MOOT by #36 (S7):** the `renders` table + bucket no longer exist | S | S7 (moot via #36) | ~#4 (old Naldo list) |
| 9 | Manual satellite upload on `/quote/new` (front + satellite split) — the manual satellite slot feeds the design + training capture (shipped via #8 Stage A) | M | S7 | #28a |
| 8 | **AI training / designer-brain system** (epic) → detail in [[task_ai_training_refinement]]. **Stage A** capture (PR #30) · **Stage B** Voyage+pgvector similarity retrieval (PR #31) · **Stage C** C1 per-example seed→final diff + C2 corpus bias block + C3 satellite orientation self-check (PR #33) + C4 garland sections from box×scale (PR #34). **C6 (per-detection confidence) intentionally DEFERRED** (revisit once real post-launch correction data shows it's worth the schema + editor-UI cost). All Stage C teaching no-ops until the corpus repopulates post-launch (training data wiped S8). | L (epic) | S7–S8 | #28 |
| 17 | **Pricing update (Naldo's numbers)** — standalone bow $0→$35; tax 8.625%→8.75%; wreath/garland **"Labor" tier removed** + tiers relabeled (`bow`=Non-Decorated, `fullDecor`=Decorated; internal keys kept); 36" Oregon wreath deleted; wreath non-deco 24/30/36/48 = $200/$285/$315/$450 (deco unchanged) + new 60" ($885/$1130) & 72" ($1149/$1455); garland non-deco 9ft $162 / 4.5ft $135 (deco unchanged). Touched the price book, shared types, AI enums, seed validation, legacy training pages, **shared editor-core dropdowns (RELAY done — design tool mirrored at `6479786`)**, + tests. NO pending prices left. | M | S8 | #8 |
| 12 | **Operator "recommend items"** — a per-item `recommended` flag (SEPARATE from `included`): builder Quote-Breakdown checkboxes on per-unit + custom rows (roofline keeps its radio) write back to the scene/form; a "Recommended subtotal (customer's starting total)" line + under-$1,000 warning. Portal pre-selects ONLY recommended items + a "Recommended" label (non-rec = optional add-ons); sub-detail line removed. Fallback (none recommended) escalates the default package to clear the $1,000 minimum. **FUTURE:** an "Our Recommendation" package when packages get built. | M | S8 | #19 |
| 10 | **Portal color/pattern picker** — CUSTOMER-facing swatch row on the portal hero; picking a whole-house color/pattern RECOLORS the live design in real time (`render-readonly` `colorOverride`/`setColorOverride` overrides light items' `colorPattern` at render time — strand/spritzer/mini-area only; shallow clone, scene never mutated; "As designed" = no override). Choice frozen into `approval_snapshot.customerSelection.colorSchemeId`. Single editable `COLOR_SCHEMES` list in `lib/design/colorSchemes.ts` (12: As designed/Warm White/Pure White/Red/Green/Blue/Purple/Multicolor/Champagne/Candy Cane/Christmas/Blue & White). **Operator-default DROPPED** (Jason, S9 — portal always defaults to "As designed"; no builder control, no data-model field). No pricing impact, no migration. PR #38. | M | S9 | #26 |
| 26 | **Scroll-wheel zoom + pan in the measurement image box** — wheel = zoom toward the cursor (clamped 1–4×), drag empty background = pan (clamped so the scaled image always fills the box), Reset view. Shared `src/lib/useImageZoomPan.ts` (pure clamp/anchor math unit-tested); transform applied to the element whose `getBoundingClientRect` drives the point math, so click/drag stay correct at any zoom; point handles `stopPropagation` so grabbing a point never pans; zoom/pan pause while placing points. Wired into quote/new **Satellite tab** + **/training/new** photo markup (the quote/new Street/Design tab already had the Konva editor's own camera controls). PR #41. | M | S9 | — |

## 🟡 In planning — NOT building yet
*(none — #8, #9, #27, #35 all shipped; see ✅ Completed above.)*

## 🔜 Backlog — active dev (priority order)
| # | Task | Size | Notes | Old # |
|---|------|------|-------|-------|
| 13 | Multi-image quoting (manual-only, no AI auto-quote) | L | big | #22 |
| 14 | Corner-house default → front-door view | M | feasibility TBD | #20 |
| 29 | **Restyle the embedded design editor to match the quote tool (the "Option A" cohesion pass)** — Jason's explicit want (S4). Phase 1 dropped the design tool's editor in AS-IS via **Option B** (its own vanilla side panels, wrapped in a React shell — fast, low-risk). This task is the follow-on cleanup: rebuild those side panels/buttons in the quote tool's React+Tailwind style so the editor looks/feels native, wired to the shared engine. Same functionality — a rebuild of the controls, not a reskin; needs testing. Ties into the shared `editor-core`/`EditorStorage` work (see [[project_integration]]). | M–L | design editor (new, raised S4) — future cohesion pass | — |
| 32 | **Port the design tool's Settings menu → quote tool (epic, phased)** + make spritzer density editable. Decided (Jason, S9): **full 6-tab port · global app-wide · spritzer density global-live · dedicated `/settings` page.** **Phase 1 SHIPPED (S9, PR #43):** `app_settings` table (key→JSON, applied to prod) + `/api/settings` + `lib/appSettings`; shared `editor-core/renderSettings.ts` seam (mutable global like colors.ts) + `spritzer.ts` reads `getRenderSettings().spritzerRayDensity` (7–36 clamp kept, Jason's call — knob is subtle/capped by design); `/settings` page (Palette + Rendering tabs); applied in editor shell + portal; ⚙ link in editor bar. **Relay CLOSED** — design tool vendored renderSettings.ts verbatim + applied the spritzer.ts edits (cores byte-identical/in sync), built their own `/api/settings/render` + Render-tab slider, verified live. **editor.ts kept byte-identical** — renderSettings is applied in the app shells, NOT loaded inside editor.ts. **Phase 2 SHIPPED (S9, PR #44):** per-type SEED defaults — data-driven `SECTIONS`/`FieldSpec` + `DEFAULT_TOOL_DEFAULTS` + `mergeToolDefaults` (`src/lib/settings/toolDefaults.ts`), a field renderer (`SettingsField`: spacing/style/number/bool/font + color-pattern editor) + `DefaultsTabPanel`, wired as the Lights/Decor/Text/Poles/Custom tabs on `/settings`. **NO editor-core change / no relay / no migration** — editor.ts already loads+applies `app_settings.defaults` at init. (Custom tab = the `autoHalo` toggle only.) **Phase 3 PENDING (only piece left):** custom graphic library — Supabase Storage bucket + upload/list/delete API + the Custom-tab upload UI; wire `storage.listUploads/createUpload/deleteUpload` (currently stubbed). | L (epic) | Ph1+2 S9; Ph3 next | — |

## ⏸️ Pending / needs Naldo (blocked — not active dev)
| # | Task | Size | Notes | Old # |
|---|------|------|-------|-------|
| 19 | Dormant portals decision (keep dark/concierge components?) | S | | #6 |
| 20 | Dev Supabase environment | S | | #7 |
| 21 | HighLevel stage mapping | S | | #9 |
| 22 | Real Google reviews + rating/count on portal | S | | #10 |
| 23 | Phone/video assets | S | | #11 |
| 24 | Apply migration + image cleanup | S | | #14 |

## 🗄️ Shelved — planned but dropped (never started; kept for reference, not active dev)
*Tasks we decided NOT to build, parked here instead of deleted in case they come back.*
| # | Task | Size | Why dropped | Old # |
|---|------|------|-------------|-------|
| 15 | Move Street View camera along the road | M | Dropped S9 (Jason) — not worth building. Was: feasibility TBD. Un-shelve if it ever becomes worth it. | #21 |
| 16 | Wire prod CRM + home.works | M | Dropped S9 (Jason) — NOT integrating home.works into this quote tool. (The approve route still has a home.works Zapier hook in code, but it's not being wired up; CRM/HighLevel work, if any, would be re-scoped as a new task.) | #5 |

> Note: #8 fully shipped through Stage C/C4 (only **C6** = per-detection confidence deferred); #9/#10/#12/#17/#26/#27/#35 also shipped. **#32 IN PROGRESS** (Settings-menu epic — Phase 1+2 shipped S9; **only Phase 3 left** = custom graphic library). **Active dev = the 🔜 Backlog** (#32 Phase 3, then #13/#14/#29). Sizes are Jason-confirmed (don't silently adjust). No external blockers outstanding (#17 prices all in). **#15** (Street View camera along the road) **shelved S9** → see 🗄️ Shelved. The **#10 operator-default** idea is settled as **won't-do** — the portal always opening "As designed" is the intended behavior (Jason, S9).
